#!/bin/bash
# 本番セッションで、ガラスの仕事量・GPU・CPU を 1 秒ごとに記録し、シナリオまたは画面の状況ごとに集計する。
#
# ベンチで測る（おすすめ）:
#   1. このスクリプトを起動する:  tools/perf/glass-monitor.sh [保存先ファイル]（省略時は logs/ に作る）
#   2. Looking Glass (Alt+F2 → lg) で  global._lgBench.run('all')
#      （tools/perf/lg-bench@liquid-glass.test。B1〜B15 を順に再現し、記録の開始・停止も自動）
#      ガラスなしとの比較は run('all', {ab: true})（= {modes: ['stage', 'none']}）
#   3. 終わるまで（ログに "bench restored"）マウスとキーボードに触らない。終わったらこの端末で Ctrl-C。
#      シナリオ・方式ごとの平均と、その間いちばん多かった状況（狙いどおりかの確認用）を表示する。
#
# ふだんの操作を測る:
#   Looking Glass で  global._lgGlass.monitor(0)  、終わったら  global._lgGlass.monitorStop()  、この端末は Ctrl-C。
#   状況（表示中のガラス・窓の数・動いている窓など）は拡張側が毎秒自動で判定して scene=<...> に書き、
#   ここでは状況ごとに集計する。
#
# 保存済みの記録を集計し直す:  tools/perf/glass-monitor.sh --summary <ファイル>
# journal から拾い直す:  journalctl --user -o cat --since '<開始時刻>' _COMM=gnome-shell | grep -F '[monitor]' > 記録.log
#
# 1 行の項目（src/diagnostics.ts 参照）:
#   gpu    amdgpu の使用率（そのときのクロックに対する割合なので、sclk・power と併せて見る）
#   sclk   GPU のシェーダクロック、power  消費電力（APU ではチップ全体、CPU を含む）
#   cpu    gnome-shell プロセスの CPU 使用率（全スレッド、1 コア = 100%）
#   frames 描いたフレーム数、full  そのうち画面全体を描き直したフレーム数
#   <ガラス> copies=背後をコピーした回数 paints=描いた回数
#
# scene=<...> の読み方:
#   stage / no-glass        ガラスがあるか（2026-10 以前の記録には旧方式の capture / mixed もある）
#   dock calendar~ ...      表示中のガラス。~ はその秒に動いた・大きさが変わったもの、(2) は 2 枚
#   3 win: firefox busy@dock  表示中の窓の数と、何かしている窓。busy は 1 秒に 10 回以上描き直し
#                           （動画など）、moving は移動・リサイズ、anim は開閉などのアニメーション。
#                           @dock はその窓が dock のガラスと重なっていること
#   overview, ws-switch, fullscreen, locked  そのときのシェルの状態
set -u

summarize() {
  awk '
    function num(re, off,    v) {
      if (!match($0, re)) return ""
      v = substr($0, RSTART + off)
      return v + 0
    }
    /\[monitor\] bench start: / { sub(/.*bench start: /, ""); starts[++nstart] = $0; next }
    /\[monitor\] bench title / {
      t = $0; sub(/.*bench title /, "", t)
      id = t; sub(/:.*/, "", id)
      sub(/^[^:]*: /, "", t)
      title[id] = t
      next
    }
    /\[monitor\] t=/ {
      if (!match($0, /scene=<[^>]*>/)) next
      scene = substr($0, RSTART + 7, RLENGTH - 8)
      mode = scene; sub(/;.*/, "", mode)
      rest = scene; sub(/^[^;]*; */, "", rest)
      group = rest
      if (match($0, / label=[^ ]+/)) {
        label = substr($0, RSTART + 7, RLENGTH - 7)
        group = label; sub(/\/.*/, "", group)
        if (index(label, "/")) { mode = label; sub(/^[^\/]*\//, "", mode) }
        labelled++
        islabel[group] = 1
      } else {
        unlabelled++
      }
      k = group SUBSEP mode
      if (!(group in total)) order[++ngroup] = group
      total[group]++
      if (!(k in n)) modes[group] = modes[group] " " mode
      n[k]++
      sk = k SUBSEP rest
      if (!(sk in sc)) scenes[k] = scenes[k] "\t" rest
      sc[sk]++
      v = num("gpu=[0-9]+%", 4); if (v != "") { gpu[k] += v; hasgpu[k] = 1 }
      v = num("\\(max [0-9]+\\)", 5); if (v != "" && v > gmax[k]) gmax[k] = v
      v = num("sclk=[0-9]+MHz", 5); if (v != "") { sclk[k] += v; hassclk[k] = 1 }
      v = num("power=[0-9.]+W", 6); if (v != "") { power[k] += v; haspower[k] = 1 }
      v = num("cpu=[0-9]+%", 4); if (v != "") { cpu[k] += v; hascpu[k] = 1 }
      frames[k] += num("frames=[0-9]+", 7)
      full[k] += num("full=[0-9]+", 5)
      nseg = split($0, seg, / \| /)
      for (i = 2; i <= nseg; i++) {
        m = split(seg[i], f, " ")
        for (j = 2; j <= m; j++) {
          if (f[j] !~ /^(copies|paints)=[0-9]+$/) continue
          split(f[j], kv, "=")
          item = f[1] " " kv[1]
          gk = k SUBSEP item
          if (!(gk in gsum)) items[k] = items[k] "\t" item
          gsum[gk] += kv[2]
        }
      }
    }
    END {
      if (!ngroup) { print "（記録なし）"; exit }
      for (i = 1; i <= nstart; i++) print "ベンチ: " starts[i]
      bench = 0
      for (g in islabel) bench = 1
      if (bench) {
        print "== シナリオごとの 1 秒あたりの平均 =="
      } else {
        # 長く続いた状況から順に
        for (i = 1; i <= ngroup; i++)
          for (j = i + 1; j <= ngroup; j++)
            if (total[order[j]] > total[order[i]]) { t = order[i]; order[i] = order[j]; order[j] = t }
        print "== 状況ごとの 1 秒あたりの平均（長く続いた順） =="
      }
      for (i = 1; i <= ngroup; i++) {
        s = order[i]
        if (bench && !(s in islabel)) continue
        if (bench) printf "\n%s %s\n", s, title[s]
        else printf "\n[%s]  計 %ds\n", s, total[s]
        nm = split(modes[s], ms, " ")
        for (j = 1; j <= nm; j++) {
          k = s SUBSEP ms[j]
          printf "  %-8s %4ds", ms[j], n[k]
          if (hasgpu[k]) printf "  gpu %5.1f%% (max %3d)", gpu[k] / n[k], gmax[k]
          if (hassclk[k]) printf "  sclk %5.0fMHz", sclk[k] / n[k]
          if (haspower[k]) printf "  power %5.1fW", power[k] / n[k]
          if (hascpu[k]) printf "  cpu %5.1f%%", cpu[k] / n[k]
          printf "  frames %5.1f  full %5.1f", frames[k] / n[k], full[k] / n[k]
          ni = split(items[k], it, "\t")
          for (q = 2; q <= ni; q++) printf "  %s %.1f", it[q], gsum[k SUBSEP it[q]] / n[k]
          printf "\n"
          if (bench) {
            # いちばん多かった状況（シナリオが狙いどおりかの確認用）
            best = ""; bestn = 0
            nsc = split(scenes[k], ss, "\t")
            for (q = 2; q <= nsc; q++) if (sc[k SUBSEP ss[q]] > bestn) { best = ss[q]; bestn = sc[k SUBSEP ss[q]] }
            printf "           scene %d/%ds: %s\n", bestn, n[k], best
          }
        }
      }
      if (bench && unlabelled) printf "\n（ラベルなしの %d 秒は準備中の秒として除外）\n", unlabelled
    }' "$1"
}

if [ "${1:-}" = "--summary" ]; then
  [ -f "${2:-}" ] || { echo "使い方: $0 --summary <記録ファイル>" >&2; exit 1; }
  summarize "$2"
  exit 0
fi

# 既定の保存先はリポジトリ直下の logs/（.gitignore 済み）
if [ -z "${1:-}" ]; then
  mkdir -p "$(dirname "$0")/../../logs"
  out="$(cd "$(dirname "$0")/../../logs" && pwd)/glass-monitor-$(date +%Y%m%d-%H%M%S).log"
else
  out=$1
fi
: >"$out"
echo "記録先: $out"
echo "Looking Glass で global._lgBench.run('all') か global._lgGlass.monitor(0) を実行してください。終わったらここで Ctrl-C。"

on_exit() {
  kill "$follower" 2>/dev/null
  wait "$follower" 2>/dev/null
  echo
  summarize "$out"
  echo
  echo "記録: $out（集計し直すには $0 --summary $out）"
  exit 0
}

journalctl --user -f -o cat --since now _COMM=gnome-shell 2>/dev/null |
  grep --line-buffered -F '[Liquid Glass][monitor]' |
  while IFS= read -r line; do
    printf '%s %s\n' "$(date +%T)" "$line" >>"$out"
    printf '%s %s\n' "$(date +%T)" "${line#*\[monitor\] }"
  done &
follower=$!
trap on_exit INT TERM
wait "$follower"
on_exit
