/*
 * Clutter.
 *
 * An OpenGL based 'interactive canvas' library.
 *
 * Authored By Matthew Allum  <mallum@openedhand.com>
 *
 * Copyright (C) 2006 OpenedHand
 *
 * This library is free software; you can redistribute it and/or
 * modify it under the terms of the GNU Lesser General Public
 * License as published by the Free Software Foundation; either
 * version 2 of the License, or (at your option) any later version.
 *
 * This library is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the GNU
 * Lesser General Public License for more details.
 *
 * You should have received a copy of the GNU Lesser General Public
 * License along with this library. If not, see <http://www.gnu.org/licenses/>.
 */

/**
 * ClutterStage:
 *
 * Top level visual element to which actors are placed.
 *
 * #ClutterStage is a top level 'window' on which child actors are placed
 * and manipulated.
 *
 * #ClutterStage is a proxy actor, wrapping the backend-specific implementation
 * (a #StageWindow) of the windowing system. It is possible to subclass
 * #ClutterStage, as long as every overridden virtual function chains up to the
 * parent class corresponding function.
 */

#include "config.h"

#include <math.h>

#include "clutter/clutter-stage.h"

#ifdef HAVE_FONTS
#include "clutter/pango/clutter-actor-pango.h"
#include "clutter/pango/clutter-text-node.h"
#endif
#include "clutter/clutter-stage-accessible-private.h"
#include "clutter/clutter-action-private.h"
#include "clutter/clutter-actor-private.h"
#include "clutter/clutter-backend-private.h"
#include "clutter/clutter-context-private.h"
#include "clutter/clutter-debug.h"
#include "clutter/clutter-enum-types.h"
#include "clutter/clutter-event-private.h"
#include "clutter/clutter-focus-private.h"
#include "clutter/clutter-frame-clock.h"
#include "clutter/clutter-frame.h"
#include "clutter/clutter-grab-private.h"
#include "clutter/clutter-input-device-private.h"
#include "clutter/clutter-input-only-actor.h"
#include "clutter/clutter-main.h"
#include "clutter/clutter-marshal.h"
#include "clutter/clutter-mutter.h"
#include "clutter/clutter-paint-context-private.h"
#include "clutter/clutter-paint-volume-private.h"
#include "clutter/clutter-pick-context-private.h"
#include "clutter/clutter-private.h"
#include "clutter/clutter-seat-private.h"
#include "clutter/clutter-sprite-private.h"
#include "clutter/clutter-stage-manager-private.h"
#include "clutter/clutter-stage-private.h"
#include "clutter/clutter-stage-view-private.h"
#include "clutter/clutter-private.h"

#include "cogl/cogl.h"

#define MAX_FRUSTA 64

typedef struct _PickRecord
{
  graphene_point_t vertex[4];
  ClutterActor *actor;
  int clip_stack_top;
} PickRecord;

typedef struct _PickClipRecord
{
  int prev;
  graphene_point_t vertex[4];
} PickClipRecord;

typedef struct _ClutterStagePrivate
{
  /* the stage implementation */
  ClutterStageWindow *impl;

  ClutterPerspective perspective;
  graphene_matrix_t projection;
  graphene_matrix_t inverse_projection;
  graphene_matrix_t view;
  float viewport[4];

  ClutterGrab *topmost_grab;

  GQueue *event_queue;

  GSList *pending_relayouts;

  int update_freeze_count;

  gboolean update_scheduled;

  GPtrArray *all_active_gestures;

  guint actor_needs_immediate_relayout : 1;
  gboolean is_active;
} ClutterStagePrivate;

enum
{
  PROP_0,

  PROP_PERSPECTIVE,
  PROP_KEY_FOCUS,
  PROP_IS_GRABBED,

  PROP_LAST
};

static GParamSpec *obj_props[PROP_LAST] = { NULL, };

enum
{
  DELETE_EVENT,
  BEFORE_UPDATE,
  PREPARE_FRAME,
  BEFORE_PAINT,
  AFTER_PAINT,
  SKIPPED_PAINT,
  AFTER_UPDATE,
  PAINT_VIEW,
  PRESENTED,
  GL_VIDEO_MEMORY_PURGED,

  LAST_SIGNAL
};

static guint stage_signals[LAST_SIGNAL] = { 0, };

static const CoglColor default_stage_color = { 255, 255, 255, 255 };

static void clutter_stage_update_view_perspective (ClutterStage *stage);
static void clutter_stage_set_viewport (ClutterStage *stage,
                                        float         width,
                                        float         height);

static void clutter_stage_pick_and_update_sprite (ClutterStage             *stage,
                                                  ClutterSprite            *sprite,
                                                  ClutterInputDevice       *source_device,
                                                  ClutterDeviceUpdateFlags  flags,
                                                  graphene_point_t          point,
                                                  uint32_t                  time_ms);

G_DEFINE_TYPE_WITH_PRIVATE (ClutterStage, clutter_stage, CLUTTER_TYPE_ACTOR)

static void
clutter_stage_get_preferred_width (ClutterActor *self,
                                   gfloat        for_height,
                                   gfloat       *min_width_p,
                                   gfloat       *natural_width_p)
{
  ClutterStagePrivate *priv =
    clutter_stage_get_instance_private (CLUTTER_STAGE (self));
  MtkRectangle geom;

  if (priv->impl == NULL)
    return;

  _clutter_stage_window_get_geometry (priv->impl, &geom);

  if (min_width_p)
    *min_width_p = geom.width;

  if (natural_width_p)
    *natural_width_p = geom.width;
}

static void
clutter_stage_get_preferred_height (ClutterActor *self,
                                    gfloat        for_width,
                                    gfloat       *min_height_p,
                                    gfloat       *natural_height_p)
{
  ClutterStagePrivate *priv =
    clutter_stage_get_instance_private (CLUTTER_STAGE (self));
  MtkRectangle geom;

  if (priv->impl == NULL)
    return;

  _clutter_stage_window_get_geometry (priv->impl, &geom);

  if (min_height_p)
    *min_height_p = geom.height;

  if (natural_height_p)
    *natural_height_p = geom.height;
}

static void
clutter_stage_add_redraw_clip (ClutterStage *stage,
                               MtkRectangle *clip)
{
  GList *l;

  for (l = clutter_stage_peek_stage_views (stage); l; l = l->next)
    {
      ClutterStageView *view = l->data;

      if (!clip)
        {
          clutter_stage_view_add_redraw_clip (view, NULL);
        }
      else
        {
          MtkRectangle view_layout;
          MtkRectangle intersection;

          clutter_stage_view_get_layout (view, &view_layout);
          if (mtk_rectangle_intersect (&view_layout, clip,
                                       &intersection))
            clutter_stage_view_add_redraw_clip (view, &intersection);
        }
    }
}

static inline void
queue_full_redraw (ClutterStage *stage)
{
  ClutterStageWindow *stage_window;

  if (CLUTTER_ACTOR_IN_DESTRUCTION (stage))
    return;

  clutter_actor_queue_redraw (CLUTTER_ACTOR (stage));

  /* Just calling clutter_actor_queue_redraw will typically only
   * redraw the bounding box of the children parented on the stage but
   * in this case we really need to ensure that the full stage is
   * redrawn so we add a NULL redraw clip to the stage window. */
  stage_window = _clutter_stage_get_window (stage);
  if (stage_window == NULL)
    return;

  clutter_stage_add_redraw_clip (stage, NULL);
}

static void
clutter_stage_allocate (ClutterActor           *self,
                        const ClutterActorBox  *box)
{
  ClutterStagePrivate *priv =
    clutter_stage_get_instance_private (CLUTTER_STAGE (self));
  ClutterActorBox alloc = CLUTTER_ACTOR_BOX_INIT_ZERO;
  float new_width, new_height;
  float width, height;
  MtkRectangle window_size;
  ClutterActorBox children_box;
  ClutterLayoutManager *layout_manager = clutter_actor_get_layout_manager (self);

  if (priv->impl == NULL)
    return;

  /* the current allocation */
  clutter_actor_box_get_size (box, &width, &height);

  /* the current Stage implementation size */
  _clutter_stage_window_get_geometry (priv->impl, &window_size);

  children_box.x1 = children_box.y1 = 0.f;
  children_box.x2 = box->x2 - box->x1;
  children_box.y2 = box->y2 - box->y1;

  CLUTTER_NOTE (LAYOUT,
                "Following allocation to %.2fx%.2f",
                width, height);

  clutter_actor_set_allocation (self, box);

  clutter_layout_manager_allocate (layout_manager,
                                   self,
                                   &children_box);

  if (window_size.width != CLUTTER_NEARBYINT (width) ||
      window_size.height != CLUTTER_NEARBYINT (height))
    {
      _clutter_stage_window_resize (priv->impl,
                                    CLUTTER_NEARBYINT (width),
                                    CLUTTER_NEARBYINT (height));
    }

  /* set the viewport to the new allocation */
  clutter_actor_get_allocation_box (self, &alloc);
  clutter_actor_box_get_size (&alloc, &new_width, &new_height);

  clutter_stage_set_viewport (CLUTTER_STAGE (self), new_width, new_height);
}

static void
setup_clip_frustum (ClutterStage       *stage,
                    const MtkRectangle *clip,
                    graphene_frustum_t *frustum)
{
  ClutterStagePrivate *priv = clutter_stage_get_instance_private (stage);
  MtkRectangle geom;
  graphene_point3d_t camera_position;
  graphene_point3d_t p[4];
  graphene_plane_t planes[6];
  graphene_vec4_t v;
  int i;

  _clutter_stage_window_get_geometry (priv->impl, &geom);

  CLUTTER_NOTE (CLIPPING, "Creating stage clip frustum for "
                "x=%d, y=%d, width=%d, height=%d",
                clip->x, clip->y, clip->width, clip->height);

  camera_position = GRAPHENE_POINT3D_INIT_ZERO;

  p[0] = GRAPHENE_POINT3D_INIT (MAX (clip->x, 0), MAX (clip->y, 0), 0.f);
  p[2] = GRAPHENE_POINT3D_INIT (MIN (clip->x + clip->width, geom.width),
                                MIN (clip->y + clip->height, geom.height),
                                0.f);

  for (i = 0; i < 2; i++)
    {
      float w = 1.0;
      cogl_graphene_matrix_project_point (&priv->view,
                                          &p[2 * i].x,
                                          &p[2 * i].y,
                                          &p[2 * i].z,
                                          &w);
    }

  graphene_point3d_init (&p[1], p[2].x, p[0].y, p[0].z);
  graphene_point3d_init (&p[3], p[0].x, p[2].y, p[0].z);

  for (i = 0; i < 4; i++)
    {
      graphene_plane_init_from_points (&planes[i],
                                       &camera_position,
                                       &p[i],
                                       &p[(i + 1) % 4]);
    }

  graphene_vec4_init (&v, 0.f, 0.f, -1.f, priv->perspective.z_near);
  graphene_plane_init_from_vec4 (&planes[4], &v);

  graphene_vec4_init (&v, 0.f, 0.f, 1.f, priv->perspective.z_far);
  graphene_plane_init_from_vec4 (&planes[5], &v);

  graphene_frustum_init (frustum,
                         &planes[0], &planes[1],
                         &planes[2], &planes[3],
                         &planes[4], &planes[5]);
}

static void
clutter_stage_do_paint_view (ClutterStage     *stage,
                             ClutterStageView *view,
                             ClutterFrame     *frame,
                             const MtkRegion  *redraw_clip)
{
  ClutterPaintContext *paint_context;
  MtkRectangle clip_rect;
  g_autoptr (GArray) clip_frusta = NULL;
  graphene_frustum_t clip_frustum;
  ClutterColorState *color_state;
  ClutterPaintNode *root_node;
  CoglFramebuffer *fb;
  CoglColor bg_color;
  int n_rectangles;
  ClutterPaintFlag paint_flags;

  n_rectangles = redraw_clip ? mtk_region_num_rectangles (redraw_clip) : 0;
  if (redraw_clip && n_rectangles < MAX_FRUSTA)
    {
      int i;

      clip_frusta = g_array_sized_new (FALSE, FALSE,
                                       sizeof (graphene_frustum_t),
                                       n_rectangles);

      for (i = 0; i < n_rectangles; i++)
        {
          clip_rect = mtk_region_get_rectangle (redraw_clip, i);
          setup_clip_frustum (stage, &clip_rect, &clip_frustum);
          g_array_append_val (clip_frusta, clip_frustum);
        }
    }
  else
    {
      clip_frusta = g_array_sized_new (FALSE, FALSE,
                                       sizeof (graphene_frustum_t),
                                       1);
      if (redraw_clip)
        clip_rect = mtk_region_get_extents (redraw_clip);
      else
        clutter_stage_view_get_layout (view, &clip_rect);

      setup_clip_frustum (stage, &clip_rect, &clip_frustum);
      g_array_append_val (clip_frusta, clip_frustum);
    }

  paint_flags = clutter_stage_view_get_default_paint_flags (view);

  paint_context = clutter_paint_context_new_for_view (view,
                                                      redraw_clip,
                                                      clip_frusta,
                                                      paint_flags);

  if (frame)
    clutter_paint_context_assign_frame (paint_context, frame);

  clutter_actor_get_background_color (CLUTTER_ACTOR (stage), &bg_color);
  bg_color.alpha = 255;

  fb = clutter_stage_view_get_framebuffer (view);
  color_state = clutter_actor_get_color_state (CLUTTER_ACTOR (stage));

  root_node = clutter_root_node_new (fb,
                                     color_state,
                                     &bg_color,
                                     COGL_BUFFER_BIT_DEPTH);

  clutter_paint_node_set_static_name (root_node, "Stage (root)");
  clutter_paint_node_paint (root_node, paint_context);
  clutter_paint_node_unref (root_node);

  clutter_actor_paint (CLUTTER_ACTOR (stage), paint_context);
  clutter_paint_context_destroy (paint_context);
}

/* This provides a common point of entry for painting the scenegraph
 * for picking or painting...
 */
void
clutter_stage_paint_view (ClutterStage     *stage,
                          ClutterStageView *view,
                          const MtkRegion  *redraw_clip,
                          ClutterFrame     *frame)
{
  ClutterStagePrivate *priv = clutter_stage_get_instance_private (stage);

  if (!priv->impl)
    return;

  COGL_TRACE_BEGIN_SCOPED (ClutterStagePaintView, "Clutter::Stage::paint_view()");

  if (g_signal_has_handler_pending (stage, stage_signals[PAINT_VIEW],
                                    0, TRUE))
    g_signal_emit (stage, stage_signals[PAINT_VIEW], 0, view, redraw_clip, frame);
  else
    CLUTTER_STAGE_GET_CLASS (stage)->paint_view (stage, view, redraw_clip, frame);
}

void
clutter_stage_emit_before_update (ClutterStage     *stage,
                                  ClutterStageView *view,
                                  ClutterFrame     *frame)
{
  g_signal_emit (stage, stage_signals[BEFORE_UPDATE], 0, view, frame);
}

void
clutter_stage_emit_prepare_frame (ClutterStage     *stage,
                                  ClutterStageView *view,
                                  ClutterFrame     *frame)
{
  g_signal_emit (stage, stage_signals[PREPARE_FRAME], 0, view, frame);
}

void
clutter_stage_emit_before_paint (ClutterStage     *stage,
                                 ClutterStageView *view,
                                 ClutterFrame     *frame)
{
  g_signal_emit (stage, stage_signals[BEFORE_PAINT], 0, view, frame);
}

void
clutter_stage_emit_after_paint (ClutterStage     *stage,
                                ClutterStageView *view,
                                ClutterFrame     *frame)
{
  g_signal_emit (stage, stage_signals[AFTER_PAINT], 0, view, frame);
}

void
clutter_stage_emit_skipped_paint (ClutterStage     *stage,
                                  ClutterStageView *view,
                                  ClutterFrame     *frame)
{
  g_signal_emit (stage, stage_signals[SKIPPED_PAINT], 0, view, frame);
}

void
clutter_stage_after_update (ClutterStage     *stage,
                            ClutterStageView *view,
                            ClutterFrame     *frame)
{
  ClutterStagePrivate *priv = clutter_stage_get_instance_private (stage);

  g_signal_emit (stage, stage_signals[AFTER_UPDATE], 0, view, frame);

  priv->update_scheduled = FALSE;
}

void
clutter_stage_frame_discarded (ClutterStage     *stage,
                               ClutterStageView *view,
                               ClutterFrame     *frame)
{
  ClutterStagePrivate *priv = clutter_stage_get_instance_private (stage);

  priv->update_scheduled = FALSE;
}

static gboolean
clutter_stage_get_paint_volume (ClutterActor *self,
                                ClutterPaintVolume *volume)
{
  /* Returning False effectively means Clutter has to assume it covers
   * everything... */
  return FALSE;
}

static void
clutter_stage_realize (ClutterActor *self)
{
  ClutterStagePrivate *priv =
    clutter_stage_get_instance_private (CLUTTER_STAGE (self));
  gboolean is_realized;

  g_assert (priv->impl != NULL);
  is_realized = _clutter_stage_window_realize (priv->impl);

  if (!is_realized)
    self->flags &= ~CLUTTER_ACTOR_REALIZED;
}

static void
clutter_stage_unrealize (ClutterActor *self)
{
  ClutterStagePrivate *priv =
    clutter_stage_get_instance_private (CLUTTER_STAGE (self));

  /* and then unrealize the implementation */
  g_assert (priv->impl != NULL);
  _clutter_stage_window_unrealize (priv->impl);

  self->flags &= ~CLUTTER_ACTOR_REALIZED;
}

static void
clutter_stage_show (ClutterActor *self)
{
  ClutterStagePrivate *priv =
    clutter_stage_get_instance_private (CLUTTER_STAGE (self));

  CLUTTER_ACTOR_CLASS (clutter_stage_parent_class)->show (self);

  /* Possibly do an allocation run so that the stage will have the
     right size before we map it */
  clutter_stage_maybe_relayout (self);

  g_assert (priv->impl != NULL);
  _clutter_stage_window_show (priv->impl, TRUE);
}

static void
clutter_stage_hide_all (ClutterActor *self)
{
  ClutterActorIter iter;
  ClutterActor *child;

  clutter_actor_hide (self);

  /* we don't do a recursive hide_all(), to maintain the old invariants
   * from ClutterGroup
   */
  clutter_actor_iter_init (&iter, self);
  while (clutter_actor_iter_next (&iter, &child))
    clutter_actor_hide (child);
}

static void
clutter_stage_hide (ClutterActor *self)
{
  ClutterStagePrivate *priv =
    clutter_stage_get_instance_private (CLUTTER_STAGE (self));

  g_assert (priv->impl != NULL);
  _clutter_stage_window_hide (priv->impl);

  CLUTTER_ACTOR_CLASS (clutter_stage_parent_class)->hide (self);
}

gboolean
clutter_stage_is_active (ClutterStage *stage)
{
  ClutterStagePrivate *priv;

  g_return_val_if_fail (CLUTTER_IS_STAGE (stage), FALSE);

  priv = clutter_stage_get_instance_private (stage);

  return priv->is_active;
}

void
clutter_stage_set_active (ClutterStage *stage,
                          gboolean      is_active)
{
  ClutterStagePrivate *priv;
  AtkObject *accessible;
  ClutterContext *context;
  ClutterBackend *backend;
  ClutterKeyFocus *key_focus;
  ClutterActor *focus_actor;

  g_return_if_fail (CLUTTER_IS_STAGE (stage));

  priv = clutter_stage_get_instance_private (stage);

  if (priv->is_active == is_active)
    return;

  priv->is_active = is_active;

  if (is_active)
    clutter_actor_add_accessible_state (CLUTTER_ACTOR (stage),
                                        ATK_STATE_ACTIVE);
  else
    clutter_actor_remove_accessible_state (CLUTTER_ACTOR (stage),
                                           ATK_STATE_ACTIVE);

  accessible = clutter_actor_get_accessible (CLUTTER_ACTOR (stage));
  if (accessible)
    {
      /* Emit AtkWindow signals */
      if (priv->is_active)
        g_signal_emit_by_name (accessible, "activate", 0);
      else
        g_signal_emit_by_name (accessible, "deactivate", 0);
    }

  context = clutter_actor_get_context (CLUTTER_ACTOR (stage));
  backend = clutter_context_get_backend (context);
  key_focus = clutter_backend_get_key_focus (backend, stage);

  focus_actor =
    clutter_focus_get_current_actor (CLUTTER_FOCUS (key_focus));

  if (clutter_focus_set_current_actor (CLUTTER_FOCUS (key_focus),
                                       focus_actor, NULL,
                                       CLUTTER_CURRENT_TIME))
    g_object_notify_by_pspec (G_OBJECT (stage), obj_props[PROP_KEY_FOCUS]);
}

void
_clutter_stage_queue_event (ClutterStage *stage,
                            ClutterEvent *event,
                            gboolean      copy_event)
{
  ClutterStagePrivate *priv;

  g_return_if_fail (CLUTTER_IS_STAGE (stage));

  priv = clutter_stage_get_instance_private (stage);

  g_queue_push_tail (priv->event_queue,
                     copy_event ? clutter_event_copy (event) : event);

  clutter_stage_schedule_update (stage);
}

static ClutterEvent *
clutter_stage_compress_motion (ClutterStage       *stage,
                               ClutterEvent       *event,
                               const ClutterEvent *to_discard)
{
  double dx, dy;
  double dx_unaccel, dy_unaccel;
  double dx_constrained, dy_constrained;
  double dst_dx = 0.0, dst_dy = 0.0;
  double dst_dx_unaccel = 0.0, dst_dy_unaccel = 0.0;
  double dst_dx_constrained = 0.0, dst_dy_constrained = 0.0;
  double *current_axes, *last_axes;
  guint n_current_axes, n_last_axes;
  graphene_point_t coords;

  if (!clutter_event_get_relative_motion (to_discard,
                                          &dx, &dy,
                                          &dx_unaccel, &dy_unaccel,
                                          &dx_constrained, &dy_constrained))
    return NULL;

  clutter_event_get_relative_motion (event,
                                     &dst_dx, &dst_dy,
                                     &dst_dx_unaccel, &dst_dy_unaccel,
                                     &dst_dx_constrained, &dst_dy_constrained);

  clutter_event_get_position (event, &coords);

  /* All tablet axes but the wheel are absolute so we can use those
   * as-is. But for wheels we only compress if the current value goes in the
   * same direction.
   */
  current_axes = clutter_event_get_axes (to_discard, &n_current_axes);
  last_axes = clutter_event_get_axes (event, &n_last_axes);

  g_return_val_if_fail (!last_axes == !current_axes, NULL);

  if (current_axes)
    {
      double current_val = 0.0;
      double last_val = 0.0;

      g_return_val_if_fail (n_current_axes == CLUTTER_INPUT_AXIS_LAST, NULL);
      g_return_val_if_fail (n_last_axes == CLUTTER_INPUT_AXIS_LAST, NULL);
      g_return_val_if_fail (n_current_axes == n_last_axes, NULL);

      current_val = current_axes[CLUTTER_INPUT_AXIS_WHEEL];
      last_val = last_axes[CLUTTER_INPUT_AXIS_WHEEL];

      if ((current_val < 0.0 && last_val > 0.0) ||
          (current_val > 0.0 && last_val < 0.0))
        return NULL;

      current_axes = g_memdup2 (current_axes, sizeof (double) * n_current_axes);
      current_axes[CLUTTER_INPUT_AXIS_WHEEL] += last_axes[CLUTTER_INPUT_AXIS_WHEEL];
    }

  return clutter_event_motion_new (CLUTTER_EVENT_FLAG_RELATIVE_MOTION,
                                   clutter_event_get_time_us (event),
                                   clutter_event_get_source_device (event),
                                   clutter_event_get_device_tool (event),
                                   clutter_event_get_state (event),
                                   coords,
                                   GRAPHENE_POINT_INIT ((float) (dx + dst_dx),
                                                        (float) (dy + dst_dy)),
                                   GRAPHENE_POINT_INIT ((float) (dx_unaccel + dst_dx_unaccel),
                                                        (float) (dy_unaccel + dst_dy_unaccel)),
                                   GRAPHENE_POINT_INIT ((float) (dx_constrained + dst_dx_constrained),
                                                        (float) (dy_constrained + dst_dy_constrained)),
                                   current_axes);
}

CLUTTER_EXPORT void
_clutter_stage_process_queued_events (ClutterStage *stage)
{
  ClutterContext *context;
  ClutterBackend *backend;
  ClutterStagePrivate *priv;
  GList *events, *l;

  g_return_if_fail (CLUTTER_IS_STAGE (stage));

  COGL_TRACE_BEGIN_SCOPED (ProcessQueuedEvents, "Clutter::Stage::process_queued_events()");

  priv = clutter_stage_get_instance_private (stage);

  if (priv->event_queue->length == 0)
    return;

  /* In case the stage gets destroyed during event processing */
  g_object_ref (stage);

  /* Steal events before starting processing to avoid reentrancy
   * issues */
  events = priv->event_queue->head;
  priv->event_queue->head = NULL;
  priv->event_queue->tail = NULL;
  priv->event_queue->length = 0;

  context = clutter_actor_get_context (CLUTTER_ACTOR (stage));
  backend = clutter_context_get_backend (context);

  for (l = events; l != NULL; l = l->next)
    {
      ClutterEvent *event;
      ClutterEvent *next_event;
      ClutterSprite *sprite = NULL;
      ClutterSprite *next_sprite = NULL;
      gboolean check_sprite = FALSE;

      event = l->data;
      next_event = l->next ? l->next->data : NULL;

      COGL_TRACE_BEGIN_SCOPED (ProcessEvent,
                               "Clutter::Stage::process_queued_events#event()");
      COGL_TRACE_DESCRIBE (ProcessEvent, clutter_event_get_name (event));

      if (clutter_event_type (event) == CLUTTER_MOTION ||
          clutter_event_type (event) == CLUTTER_TOUCH_UPDATE)
        {
          sprite = clutter_backend_get_sprite (backend, stage, event);

          if (next_event != NULL &&
              (clutter_event_type (event) == clutter_event_type (next_event)))
            next_sprite = clutter_backend_get_sprite (backend, stage, next_event);
        }

      if (sprite != NULL && next_sprite != NULL)
        check_sprite = TRUE;

      /* Skip consecutive motion events coming from the same device. */
      if (next_event != NULL)
        {
          float x, y;

          clutter_event_get_coords (event, &x, &y);

          if (clutter_event_type (event) == CLUTTER_MOTION &&
              (clutter_event_type (next_event) == CLUTTER_MOTION ||
               clutter_event_type (next_event) == CLUTTER_LEAVE) &&
              (!check_sprite || (sprite == next_sprite)))
            {
              CLUTTER_NOTE (EVENT,
                            "Omitting motion event at %d, %d",
                            (int) x,
                            (int) y);

              if (clutter_event_type (next_event) == CLUTTER_MOTION)
                {
                  ClutterEvent *new_event;

                  new_event =
                    clutter_stage_compress_motion (stage, next_event, event);
                  if (new_event)
                    {
                      /* Replace the next event with the rewritten one */
                      l->next->data = new_event;
                      clutter_event_free (next_event);
                    }
                }

              goto next_event;
            }
          else if (clutter_event_type (event) == CLUTTER_TOUCH_UPDATE &&
                   clutter_event_type (next_event) == CLUTTER_TOUCH_UPDATE &&
                   clutter_event_get_event_sequence (event) ==
                   clutter_event_get_event_sequence (next_event) &&
                   (!check_sprite || (sprite == next_sprite)))
            {
              CLUTTER_NOTE (EVENT,
                            "Omitting touch update event at %d, %d",
                            (int) x,
                            (int) y);
              goto next_event;
            }
        }

      clutter_stage_process_event (stage, event);

    next_event:
      clutter_event_free (event);
    }

  g_list_free (events);

  g_object_unref (stage);
}

void
clutter_stage_queue_actor_relayout (ClutterStage *stage,
                                    ClutterActor *actor)
{
  ClutterStagePrivate *priv = clutter_stage_get_instance_private (stage);

  clutter_stage_schedule_update (stage);

  priv->pending_relayouts = g_slist_prepend (priv->pending_relayouts,
                                             g_object_ref (actor));
}

void
clutter_stage_dequeue_actor_relayout (ClutterStage *stage,
                                      ClutterActor *actor)
{
  ClutterStagePrivate *priv = clutter_stage_get_instance_private (stage);
  GSList *l;

  for (l = priv->pending_relayouts; l; l = l->next)
    {
      ClutterActor *relayout_actor = l->data;

      if (relayout_actor == actor)
        {
          g_object_unref (relayout_actor);
          priv->pending_relayouts =
            g_slist_delete_link (priv->pending_relayouts, l);

          return;
        }
    }
}

void
clutter_stage_invalidate_devices (ClutterStage *stage)
{
  GList *l;

  for (l = clutter_stage_peek_stage_views (stage); l; l = l->next)
    {
      ClutterStageView *view = l->data;

      clutter_stage_view_invalidate_input_devices (view);
    }
}

void
clutter_stage_maybe_relayout (ClutterActor *actor)
{
  ClutterStage *stage = CLUTTER_STAGE (actor);
  ClutterStagePrivate *priv = clutter_stage_get_instance_private (stage);
  g_autoptr (GSList) stolen_list = NULL;
  GSList *l;
  int count = 0;

  /* No work to do? Avoid the extraneous debug log messages too. */
  if (priv->pending_relayouts == NULL)
    return;

  COGL_TRACE_BEGIN_SCOPED (ClutterStageRelayout, "Clutter::Stage::maybe_relayout()");

  CLUTTER_NOTE (ACTOR, ">>> Recomputing layout");

  stolen_list = g_steal_pointer (&priv->pending_relayouts);
  for (l = stolen_list; l; l = l->next)
    {
      g_autoptr (ClutterActor) queued_actor = l->data;
      float x = 0.f;
      float y = 0.f;

      if (CLUTTER_ACTOR_IN_RELAYOUT (queued_actor))  /* avoid reentrancy */
        continue;

      if (queued_actor == actor)
        CLUTTER_NOTE (ACTOR, "    Deep relayout of stage %s",
                      _clutter_actor_get_debug_name (queued_actor));
      else
        CLUTTER_NOTE (ACTOR, "    Shallow relayout of actor %s",
                      _clutter_actor_get_debug_name (queued_actor));

      CLUTTER_SET_PRIVATE_FLAGS (queued_actor, CLUTTER_IN_RELAYOUT);

      clutter_actor_get_fixed_position (queued_actor, &x, &y);
      clutter_actor_allocate_preferred_size (queued_actor, x, y);

      CLUTTER_UNSET_PRIVATE_FLAGS (queued_actor, CLUTTER_IN_RELAYOUT);

      count++;
    }

  CLUTTER_NOTE (ACTOR, "<<< Completed recomputing layout of %d subtrees", count);

  if (count)
    clutter_stage_invalidate_devices (stage);
}

void
clutter_stage_finish_layout (ClutterStage *stage)
{
  ClutterActor *actor = CLUTTER_ACTOR (stage);
  ClutterStagePrivate *priv = clutter_stage_get_instance_private (stage);
  int phase;

  COGL_TRACE_BEGIN_SCOPED (ClutterStageUpdateActorStageViews,
                           "Clutter::Stage::finish_layout()");

  /* If an actor needs an immediate relayout because its resource scale
   * changed, we give it another chance to allocate correctly before
   * the paint.
   *
   * We're doing the whole thing twice and pass the phase to
   * clutter_actor_finish_layout() to allow actors to detect loops:
   * If the resource scale changes again after the relayout, the new
   * allocation of an actor probably moved the actor onto another stage
   * view, so if an actor sees phase == 1, it can choose a "final" scale.
   */
  for (phase = 0; phase < 2; phase++)
    {
      clutter_actor_finish_layout (actor, phase);

      if (!priv->actor_needs_immediate_relayout)
        break;

      priv->actor_needs_immediate_relayout = FALSE;
      clutter_stage_maybe_relayout (actor);
    }

  g_warn_if_fail (!priv->actor_needs_immediate_relayout);
}

static void
clutter_stage_real_queue_relayout (ClutterActor *self)
{
  ClutterStage *stage = CLUTTER_STAGE (self);
  ClutterActorClass *parent_class;

  clutter_stage_queue_actor_relayout (stage, self);

  /* chain up */
  parent_class = CLUTTER_ACTOR_CLASS (clutter_stage_parent_class);
  parent_class->queue_relayout (self);
}

static gboolean
is_full_stage_redraw_queued (ClutterStage *stage)
{
  GList *l;

  for (l = clutter_stage_peek_stage_views (stage); l; l = l->next)
    {
      ClutterStageView *view = l->data;

      if (!clutter_stage_view_has_full_redraw_clip (view))
        return FALSE;
    }

  return TRUE;
}

static void
setup_ray_for_coordinates (ClutterStage       *stage,
                           float               x,
                           float               y,
                           graphene_point3d_t *point,
                           graphene_ray_t     *ray)
{
  ClutterStagePrivate *priv = clutter_stage_get_instance_private (stage);
  graphene_point3d_t camera_position;
  graphene_point3d_t p;
  graphene_vec3_t direction;
  graphene_vec3_t cv;
  graphene_vec3_t v;

  camera_position = GRAPHENE_POINT3D_INIT_ZERO;
  graphene_vec3_init (&cv,
                      camera_position.x,
                      camera_position.y,
                      camera_position.z);

  p = GRAPHENE_POINT3D_INIT (x, y, 0.f);
  graphene_matrix_transform_point3d (&priv->view, &p, &p);

  graphene_vec3_init (&v, p.x, p.y, p.z);
  graphene_vec3_subtract (&v, &cv, &direction);
  graphene_vec3_normalize (&direction, &direction);

  graphene_ray_init (ray, &camera_position, &direction);
  graphene_point3d_init_from_point (point, &p);
}

static ClutterActor *
_clutter_stage_do_pick_on_view (ClutterStage      *stage,
                                float              x,
                                float              y,
                                ClutterPickMode    mode,
                                ClutterStageView  *view,
                                MtkRegion        **clear_area)
{
  g_autoptr (ClutterPickStack) pick_stack = NULL;
  ClutterContext *context;
  ClutterBackend *backend;
  ClutterPickContext *pick_context;
  CoglContext *cogl_context;
  graphene_point3d_t p;
  graphene_ray_t ray;
  ClutterActor *actor;

  COGL_TRACE_BEGIN_SCOPED (ClutterStagePickView, "Clutter::Stage::do_pick_on_view()");

  setup_ray_for_coordinates (stage, x, y, &p, &ray);

  context = clutter_actor_get_context (CLUTTER_ACTOR (stage));
  backend = clutter_context_get_backend (context);
  cogl_context = clutter_backend_get_cogl_context (backend);
  pick_context = clutter_pick_context_new_for_view (view, cogl_context, mode, &p, &ray);

  clutter_actor_pick (CLUTTER_ACTOR (stage), pick_context);
  pick_stack = clutter_pick_context_steal_stack (pick_context);
  clutter_pick_context_destroy (pick_context);

  actor = clutter_pick_stack_search_actor (pick_stack, &p, &ray, clear_area);
  return actor ? actor : CLUTTER_ACTOR (stage);
}

/**
 * clutter_stage_get_view_at: (skip)
 */
ClutterStageView *
clutter_stage_get_view_at (ClutterStage *stage,
                           float         x,
                           float         y)
{
  ClutterStagePrivate *priv = clutter_stage_get_instance_private (stage);
  GList *l;

  for (l = _clutter_stage_window_get_views (priv->impl); l; l = l->next)
    {
      ClutterStageView *view = l->data;
      MtkRectangle view_layout;

      clutter_stage_view_get_layout (view, &view_layout);
      if (x >= view_layout.x &&
          x < view_layout.x + view_layout.width &&
          y >= view_layout.y &&
          y < view_layout.y + view_layout.height)
        return view;
    }

  return NULL;
}

static ClutterActor *
_clutter_stage_do_pick (ClutterStage     *stage,
                        float             x,
                        float             y,
                        ClutterPickMode   mode,
                        MtkRegion       **clear_area)
{
  ClutterActor *actor = CLUTTER_ACTOR (stage);
  ClutterStagePrivate *priv = clutter_stage_get_instance_private (stage);
  float stage_width, stage_height;
  ClutterStageView *view = NULL;

  priv = clutter_stage_get_instance_private (stage);

  if (CLUTTER_ACTOR_IN_DESTRUCTION (stage))
    return actor;

  if (G_UNLIKELY (clutter_pick_debug_flags & CLUTTER_DEBUG_NOP_PICKING))
    return actor;

  if (G_UNLIKELY (priv->impl == NULL))
    return actor;

  clutter_actor_get_size (CLUTTER_ACTOR (stage), &stage_width, &stage_height);
  if (x < 0 || x >= stage_width || y < 0 || y >= stage_height)
    return actor;

  view = clutter_stage_get_view_at (stage, x, y);
  if (view)
    return _clutter_stage_do_pick_on_view (stage, x, y, mode, view, clear_area);

  return actor;
}

static void
clutter_stage_real_apply_transform (ClutterActor      *stage,
                                    graphene_matrix_t *matrix)
{
  ClutterStagePrivate *priv =
    clutter_stage_get_instance_private (CLUTTER_STAGE (stage));

  /* FIXME: we probably shouldn't be explicitly resetting the matrix
   * here... */
  graphene_matrix_init_from_matrix (matrix, &priv->view);
}

static void
on_seat_unfocus_inhibited_changed (ClutterStage *stage,
                                   ClutterSeat  *seat)
{
  ClutterContext *context =
    clutter_actor_get_context (CLUTTER_ACTOR (stage));
  ClutterBackend *backend = clutter_context_get_backend (context);
  ClutterSprite *sprite = clutter_backend_get_pointer_sprite (backend, stage);
  graphene_point_t point = GRAPHENE_POINT_INIT_ZERO;

  if (clutter_seat_is_unfocus_inhibited (seat))
    {
      clutter_sprite_get_coords (sprite, &point);
      clutter_stage_pick_and_update_sprite (stage, sprite, NULL,
                                            CLUTTER_DEVICE_UPDATE_IGNORE_CACHE,
                                            point,
                                            CLUTTER_CURRENT_TIME);
    }
  else
    {
      clutter_focus_set_current_actor (CLUTTER_FOCUS (sprite), NULL,
                                       NULL, CLUTTER_CURRENT_TIME);
    }
}

static void
clutter_stage_constructed (GObject *gobject)
{
  ClutterStage *self = CLUTTER_STAGE (gobject);
  ClutterContext *context =
    clutter_actor_get_context (CLUTTER_ACTOR (self));
  ClutterBackend *backend =
    clutter_context_get_backend (context);
  ClutterStageManager *stage_manager =
    clutter_context_get_stage_manager (context);
  MtkRectangle geom = { 0, };
  ClutterStagePrivate *priv;
  ClutterStageWindow *impl;
  ClutterSeat *seat;
  GError *error = NULL;

  /* a stage is a top-level object */
  CLUTTER_SET_PRIVATE_FLAGS (self, CLUTTER_IS_TOPLEVEL);

  priv = clutter_stage_get_instance_private (self);

  CLUTTER_NOTE (BACKEND, "Creating stage from the default backend");

  impl = _clutter_backend_create_stage (backend, self, &error);

  if (G_LIKELY (impl != NULL))
    {
      _clutter_stage_set_window (self, impl);
      _clutter_stage_window_get_geometry (priv->impl, &geom);
    }
  else
    {
      if (error != NULL)
        {
          g_critical ("Unable to create a new stage implementation: %s",
                      error->message);
          g_error_free (error);
        }
      else
        g_critical ("Unable to create a new stage implementation.");
    }

  priv->event_queue = g_queue_new ();

  priv->all_active_gestures = g_ptr_array_sized_new (64);

  clutter_actor_set_background_color (CLUTTER_ACTOR (self),
                                      &default_stage_color);

  clutter_stage_queue_actor_relayout (self, CLUTTER_ACTOR (self));

  clutter_actor_set_reactive (CLUTTER_ACTOR (self), TRUE);
  clutter_stage_set_key_focus (self, NULL);
  clutter_stage_set_viewport (self, geom.width, geom.height);

  seat = clutter_backend_get_default_seat (backend);
  g_signal_connect_object (seat, "is-unfocus-inhibited-changed",
                           G_CALLBACK (on_seat_unfocus_inhibited_changed),
                           self,
                           G_CONNECT_SWAPPED);

  /* this will take care to sinking the floating reference */
  _clutter_stage_manager_add_stage (stage_manager, self);
  clutter_actor_set_accessible_role (CLUTTER_ACTOR (self), ATK_ROLE_WINDOW);

  G_OBJECT_CLASS (clutter_stage_parent_class)->constructed (gobject);
}

static void
clutter_stage_set_property (GObject      *object,
			    guint         prop_id,
			    const GValue *value,
			    GParamSpec   *pspec)
{
  ClutterStage *stage = CLUTTER_STAGE (object);

  switch (prop_id)
    {

    case PROP_KEY_FOCUS:
      clutter_stage_set_key_focus (stage, g_value_get_object (value));
      break;

    default:
      G_OBJECT_WARN_INVALID_PROPERTY_ID (object, prop_id, pspec);
      break;
  }
}

static void
clutter_stage_get_property (GObject    *gobject,
			    guint       prop_id,
			    GValue     *value,
			    GParamSpec *pspec)
{
  ClutterStage *stage = CLUTTER_STAGE (gobject);
  ClutterStagePrivate *priv =
    clutter_stage_get_instance_private (stage);

  switch (prop_id)
    {
    case PROP_PERSPECTIVE:
      g_value_set_boxed (value, &priv->perspective);
      break;

    case PROP_KEY_FOCUS:
      g_value_set_object (value, clutter_stage_get_key_focus (stage));
      break;

    case PROP_IS_GRABBED:
      g_value_set_boolean (value, !!priv->topmost_grab);
      break;

    default:
      G_OBJECT_WARN_INVALID_PROPERTY_ID (gobject, prop_id, pspec);
      break;
    }
}

static void
clutter_stage_dispose (GObject *object)
{
  ClutterStage        *stage = CLUTTER_STAGE (object);
  ClutterStagePrivate *priv = clutter_stage_get_instance_private (stage);
  ClutterContext *context;
  ClutterStageManager *stage_manager;

  clutter_actor_hide (CLUTTER_ACTOR (object));

  _clutter_clear_events_queue ();

  if (priv->impl != NULL)
    {
      CLUTTER_NOTE (BACKEND, "Disposing of the stage implementation");

      if (clutter_actor_is_realized (CLUTTER_ACTOR (object)))
        _clutter_stage_window_unrealize (priv->impl);

      g_clear_object (&priv->impl);
    }

  clutter_actor_destroy_all_children (CLUTTER_ACTOR (object));

  g_slist_free_full (priv->pending_relayouts,
                     (GDestroyNotify) g_object_unref);
  priv->pending_relayouts = NULL;

  /* this will release the reference on the stage */
  context = clutter_actor_get_context (CLUTTER_ACTOR (stage));
  stage_manager = clutter_context_get_stage_manager (context);
  _clutter_stage_manager_remove_stage (stage_manager, stage);

  G_OBJECT_CLASS (clutter_stage_parent_class)->dispose (object);
}

static void
clutter_stage_finalize (GObject *object)
{
  ClutterStage *stage = CLUTTER_STAGE (object);
  ClutterStagePrivate *priv = clutter_stage_get_instance_private (stage);

  g_queue_foreach (priv->event_queue, (GFunc) clutter_event_free, NULL);
  g_queue_free (priv->event_queue);

  g_assert (priv->all_active_gestures->len == 0);
  g_ptr_array_free (priv->all_active_gestures, TRUE);

  G_OBJECT_CLASS (clutter_stage_parent_class)->finalize (object);
}

static void
clutter_stage_real_paint_view (ClutterStage     *stage,
                               ClutterStageView *view,
                               const MtkRegion  *redraw_clip,
                               ClutterFrame     *frame)
{
  clutter_stage_do_paint_view (stage, view, frame, redraw_clip);
}

static void
clutter_stage_paint (ClutterActor        *actor,
                     ClutterPaintContext *paint_context)
{
#ifdef HAVE_FONTS
  ClutterStageView *view;
#endif

  CLUTTER_ACTOR_CLASS (clutter_stage_parent_class)->paint (actor, paint_context);

#ifdef HAVE_FONTS
  view = clutter_paint_context_get_stage_view (paint_context);
  if (view &&
      G_UNLIKELY (clutter_paint_debug_flags & CLUTTER_DEBUG_PAINT_MAX_RENDER_TIME))
    {
      MtkRectangle view_layout;
      ClutterFrameClock *frame_clock;
      g_autoptr (GString) string = NULL;
      PangoLayout *layout;
      PangoRectangle logical;
      g_autoptr (ClutterPaintNode) node = NULL;
      ClutterActorBox box;

      clutter_stage_view_get_layout (view, &view_layout);
      frame_clock = clutter_stage_view_get_frame_clock (view);

      string = clutter_frame_clock_get_max_render_time_debug_info (frame_clock);

      layout = clutter_actor_create_pango_layout (actor, string->str);
      pango_layout_set_alignment (layout, PANGO_ALIGN_RIGHT);
      pango_layout_get_pixel_extents (layout, NULL, &logical);

      node = clutter_text_node_new (layout,
                                    &COGL_COLOR_INIT (255, 255, 255, 255));

      box.x1 = view_layout.x;
      box.y1 = view_layout.y + 30;
      box.x2 = box.x1 + logical.width;
      box.y2 = box.y1 + logical.height;
      clutter_paint_node_add_rectangle (node, &box);

      clutter_paint_node_paint (node, paint_context);

      g_object_unref (layout);
    }
#endif
}

static void
clutter_stage_class_init (ClutterStageClass *klass)
{
  GObjectClass *gobject_class = G_OBJECT_CLASS (klass);
  ClutterActorClass *actor_class = CLUTTER_ACTOR_CLASS (klass);

  gobject_class->constructed = clutter_stage_constructed;
  gobject_class->set_property = clutter_stage_set_property;
  gobject_class->get_property = clutter_stage_get_property;
  gobject_class->dispose = clutter_stage_dispose;
  gobject_class->finalize = clutter_stage_finalize;

  actor_class->allocate = clutter_stage_allocate;
  actor_class->get_accessible_type = clutter_stage_accessible_get_type;
  actor_class->get_preferred_width = clutter_stage_get_preferred_width;
  actor_class->get_preferred_height = clutter_stage_get_preferred_height;
  actor_class->get_paint_volume = clutter_stage_get_paint_volume;
  actor_class->realize = clutter_stage_realize;
  actor_class->unrealize = clutter_stage_unrealize;
  actor_class->show = clutter_stage_show;
  actor_class->hide = clutter_stage_hide;
  actor_class->hide_all = clutter_stage_hide_all;
  actor_class->queue_relayout = clutter_stage_real_queue_relayout;
  actor_class->apply_transform = clutter_stage_real_apply_transform;
  actor_class->paint = clutter_stage_paint;

  klass->paint_view = clutter_stage_real_paint_view;

  /**
   * ClutterStage:perspective:
   *
   * The parameters used for the perspective projection from 3D
   * coordinates to 2D
   */
  obj_props[PROP_PERSPECTIVE] =
      g_param_spec_boxed ("perspective", NULL, NULL,
                          CLUTTER_TYPE_PERSPECTIVE,
                          G_PARAM_READABLE |
                          G_PARAM_STATIC_STRINGS |
                          G_PARAM_EXPLICIT_NOTIFY);

  /**
   * ClutterStage:key-focus:
   *
   * The [class@Clutter.Actor] that will receive key events from the underlying
   * windowing system.
   *
   * If %NULL, the #ClutterStage will receive the events.
   */
  obj_props[PROP_KEY_FOCUS] =
      g_param_spec_object ("key-focus", NULL, NULL,
                           CLUTTER_TYPE_ACTOR,
                           G_PARAM_READWRITE |
                           G_PARAM_STATIC_STRINGS |
                           G_PARAM_EXPLICIT_NOTIFY);

  /**
   * ClutterStage:is-grabbed:
   *
   * %TRUE if there is currently an active grab on the stage.
   */
  obj_props[PROP_IS_GRABBED] =
      g_param_spec_boolean ("is-grabbed", NULL, NULL,
                            FALSE,
                            G_PARAM_READABLE |
                            G_PARAM_STATIC_STRINGS |
                            G_PARAM_EXPLICIT_NOTIFY);

  g_object_class_install_properties (gobject_class, PROP_LAST, obj_props);

  /**
   * ClutterStage::before-update:
   * @stage: the #ClutterStage
   * @view: a #ClutterStageView
   * @frame: a #ClutterFrame
   */
  stage_signals[BEFORE_UPDATE] =
    g_signal_new (I_("before-update"),
                  G_TYPE_FROM_CLASS (gobject_class),
                  G_SIGNAL_RUN_LAST,
                  0,
                  NULL, NULL,
                  _clutter_marshal_VOID__OBJECT_BOXED,
                  G_TYPE_NONE, 2,
                  CLUTTER_TYPE_STAGE_VIEW,
                  CLUTTER_TYPE_FRAME | G_SIGNAL_TYPE_STATIC_SCOPE);
  g_signal_set_va_marshaller (stage_signals[BEFORE_UPDATE],
                              G_TYPE_FROM_CLASS (gobject_class),
                              _clutter_marshal_VOID__OBJECT_BOXEDv);

  /**
   * ClutterStage::prepare-frame:
   * @stage: the stage that received the event
   * @view: a #ClutterStageView
   * @frame: a #ClutterFrame
   *
   * The signal is emitted after the stage is updated,
   * before the stage is painted, even if it will not be painted.
   */
  stage_signals[PREPARE_FRAME] =
    g_signal_new (I_("prepare-frame"),
                  G_TYPE_FROM_CLASS (gobject_class),
                  G_SIGNAL_RUN_LAST,
                  0,
                  NULL, NULL,
                  _clutter_marshal_VOID__OBJECT_BOXED,
                  G_TYPE_NONE, 2,
                  CLUTTER_TYPE_STAGE_VIEW,
                  CLUTTER_TYPE_FRAME | G_SIGNAL_TYPE_STATIC_SCOPE);
  g_signal_set_va_marshaller (stage_signals[PREPARE_FRAME],
                              G_TYPE_FROM_CLASS (gobject_class),
                              _clutter_marshal_VOID__OBJECT_BOXEDv);

  /**
   * ClutterStage::before-paint:
   * @stage: the stage that received the event
   * @view: a #ClutterStageView
   * @frame: a #ClutterFrame
   *
   * The signal is emitted before the stage is painted.
   */
  stage_signals[BEFORE_PAINT] =
    g_signal_new (I_("before-paint"),
                  G_TYPE_FROM_CLASS (gobject_class),
                  G_SIGNAL_RUN_LAST,
                  G_STRUCT_OFFSET (ClutterStageClass, before_paint),
                  NULL, NULL,
                  _clutter_marshal_VOID__OBJECT_BOXED,
                  G_TYPE_NONE, 2,
                  CLUTTER_TYPE_STAGE_VIEW,
                  CLUTTER_TYPE_FRAME | G_SIGNAL_TYPE_STATIC_SCOPE);
  g_signal_set_va_marshaller (stage_signals[BEFORE_PAINT],
                              G_TYPE_FROM_CLASS (gobject_class),
                              _clutter_marshal_VOID__OBJECT_BOXEDv);

  /**
   * ClutterStage::after-paint:
   * @stage: the stage that received the event
   * @view: a #ClutterStageView
   * @frame: a #ClutterFrame
   *
   * The signal is emitted after the stage is painted,
   * but before the results are displayed on the screen.0
   */
  stage_signals[AFTER_PAINT] =
    g_signal_new (I_("after-paint"),
                  G_TYPE_FROM_CLASS (gobject_class),
                  G_SIGNAL_RUN_LAST,
                  0, /* no corresponding vfunc */
                  NULL, NULL,
                  _clutter_marshal_VOID__OBJECT_BOXED,
                  G_TYPE_NONE, 2,
                  CLUTTER_TYPE_STAGE_VIEW,
                  CLUTTER_TYPE_FRAME | G_SIGNAL_TYPE_STATIC_SCOPE);
  g_signal_set_va_marshaller (stage_signals[AFTER_PAINT],
                              G_TYPE_FROM_CLASS (gobject_class),
                              _clutter_marshal_VOID__OBJECT_BOXEDv);

  /**
   * ClutterStage::skipped-paint:
   * @stage: the stage that received the event
   * @view: a #ClutterStageView
   * @frame: a #ClutterFrame
   *
   * The ::skipped-paint signal is emitted after relayout, if no damage
   * was posted and the paint was skipped.
   */
  stage_signals[SKIPPED_PAINT] =
    g_signal_new (I_("skipped-paint"),
                  G_TYPE_FROM_CLASS (gobject_class),
                  G_SIGNAL_RUN_LAST,
                  G_STRUCT_OFFSET (ClutterStageClass, skipped_paint),
                  NULL, NULL,
                  _clutter_marshal_VOID__OBJECT_BOXED,
                  G_TYPE_NONE, 2,
                  CLUTTER_TYPE_STAGE_VIEW,
                  CLUTTER_TYPE_FRAME | G_SIGNAL_TYPE_STATIC_SCOPE);
  g_signal_set_va_marshaller (stage_signals[SKIPPED_PAINT],
                              G_TYPE_FROM_CLASS (gobject_class),
                              _clutter_marshal_VOID__OBJECT_BOXEDv);

  /**
   * ClutterStage::after-update:
   * @stage: the #ClutterStage
   * @view: a #ClutterStageView
   * @frame: a #ClutterFrame
   */
  stage_signals[AFTER_UPDATE] =
    g_signal_new (I_("after-update"),
                  G_TYPE_FROM_CLASS (gobject_class),
                  G_SIGNAL_RUN_LAST,
                  0,
                  NULL, NULL,
                  _clutter_marshal_VOID__OBJECT_BOXED,
                  G_TYPE_NONE, 2,
                  CLUTTER_TYPE_STAGE_VIEW,
                  CLUTTER_TYPE_FRAME | G_SIGNAL_TYPE_STATIC_SCOPE);
  g_signal_set_va_marshaller (stage_signals[AFTER_UPDATE],
                              G_TYPE_FROM_CLASS (gobject_class),
                              _clutter_marshal_VOID__OBJECT_BOXEDv);

  /**
   * ClutterStage::paint-view:
   * @stage: the stage that received the event
   * @view: a #ClutterStageView
   * @redraw_clip: a #MtkRegion with the redraw clip
   * @frame: a #ClutterFrame
   *
   * The signal is emitted before a [class@Clutter.StageView] is being
   * painted.
   *
   * The view is painted in the default handler. Hence, if you want to perform
   * some action after the view is painted, like reading the contents of the
   * framebuffer, use [func@GObject.signal_connect_after] or pass %G_CONNECT_AFTER.
   */
  stage_signals[PAINT_VIEW] =
    g_signal_new (I_("paint-view"),
                  G_TYPE_FROM_CLASS (gobject_class),
                  G_SIGNAL_RUN_LAST,
                  G_STRUCT_OFFSET (ClutterStageClass, paint_view),
                  NULL, NULL,
                  _clutter_marshal_VOID__OBJECT_BOXED_BOXED,
                  G_TYPE_NONE, 3,
                  CLUTTER_TYPE_STAGE_VIEW,
                  MTK_TYPE_REGION | G_SIGNAL_TYPE_STATIC_SCOPE,
                  CLUTTER_TYPE_FRAME | G_SIGNAL_TYPE_STATIC_SCOPE);
  g_signal_set_va_marshaller (stage_signals[PAINT_VIEW],
                              G_TYPE_FROM_CLASS (gobject_class),
                              _clutter_marshal_VOID__OBJECT_BOXED_BOXEDv);

  /**
   * ClutterStage::presented: (skip)
   * @stage: the stage that received the event
   * @view: the #ClutterStageView presented
   * @frame_info: a #ClutterFrameInfo
   *
   * Signals that the #ClutterStage was presented on the screen to the user.
   */
  stage_signals[PRESENTED] =
    g_signal_new (I_("presented"),
                  G_TYPE_FROM_CLASS (gobject_class),
                  G_SIGNAL_RUN_LAST,
                  0,
                  NULL, NULL,
                  _clutter_marshal_VOID__OBJECT_POINTER,
                  G_TYPE_NONE, 2,
                  CLUTTER_TYPE_STAGE_VIEW,
                  G_TYPE_POINTER);
  g_signal_set_va_marshaller (stage_signals[PRESENTED],
                              G_TYPE_FROM_CLASS (gobject_class),
                              _clutter_marshal_VOID__OBJECT_POINTERv);

 /**
   * ClutterStage::gl-video-memory-purged: (skip)
   * @stage: the stage that received the event
   *
   * Signals that the underlying GL driver has had its texture memory purged
   * so anything presently held in texture memory is now invalidated, and
   * likely corrupt. It needs redrawing.
   */
  stage_signals[GL_VIDEO_MEMORY_PURGED] =
    g_signal_new (I_("gl-video-memory-purged"),
                  G_TYPE_FROM_CLASS (gobject_class),
                  G_SIGNAL_RUN_LAST,
                  0,
                  NULL, NULL, NULL,
                  G_TYPE_NONE, 0);
}

static void
clutter_stage_init (ClutterStage *self)
{
}

static void
clutter_stage_set_perspective (ClutterStage       *stage,
                               ClutterPerspective *perspective)
{
  ClutterStagePrivate *priv = clutter_stage_get_instance_private (stage);

  if (priv->perspective.fovy == perspective->fovy &&
      priv->perspective.aspect == perspective->aspect &&
      priv->perspective.z_near == perspective->z_near &&
      priv->perspective.z_far == perspective->z_far)
    return;

  priv->perspective = *perspective;

  graphene_matrix_init_perspective (&priv->projection,
                                    priv->perspective.fovy,
                                    priv->perspective.aspect,
                                    priv->perspective.z_near,
                                    priv->perspective.z_far);
  graphene_matrix_inverse (&priv->projection,
                           &priv->inverse_projection);

  _clutter_stage_dirty_projection (stage);
  clutter_actor_queue_redraw (CLUTTER_ACTOR (stage));
}

/**
 * clutter_stage_get_perspective:
 * @stage: A #ClutterStage
 * @perspective: (out caller-allocates) (allow-none): return location for a
 *   #ClutterPerspective
 *
 * Retrieves the stage perspective.
 */
void
clutter_stage_get_perspective (ClutterStage       *stage,
                               ClutterPerspective *perspective)
{
  ClutterStagePrivate *priv;

  g_return_if_fail (CLUTTER_IS_STAGE (stage));
  g_return_if_fail (perspective != NULL);

  priv = clutter_stage_get_instance_private (stage);
  *perspective = priv->perspective;
}

/*
 * clutter_stage_get_projection_matrix:
 * @stage: A #ClutterStage
 * @projection: return location for a #graphene_matrix_t representing the
 *              perspective projection applied to actors on the given
 *              @stage.
 *
 * Retrieves the @stage's projection matrix. This is derived from the
 * current perspective.
 */
void
_clutter_stage_get_projection_matrix (ClutterStage      *stage,
                                      graphene_matrix_t *projection)
{
  ClutterStagePrivate *priv;

  g_return_if_fail (CLUTTER_IS_STAGE (stage));
  g_return_if_fail (projection != NULL);

  priv = clutter_stage_get_instance_private (stage);
  *projection = priv->projection;
}

/* This simply provides a simple mechanism for us to ensure that
 * the projection matrix gets re-asserted before painting.
 *
 * This is used when switching between multiple stages */
void
_clutter_stage_dirty_projection (ClutterStage *stage)
{
  ClutterStagePrivate *priv;
  GList *l;

  g_return_if_fail (CLUTTER_IS_STAGE (stage));

  priv = clutter_stage_get_instance_private (stage);

  for (l = _clutter_stage_window_get_views (priv->impl); l; l = l->next)
    {
      ClutterStageView *view = l->data;

      clutter_stage_view_invalidate_projection (view);
    }
}

/*
 * clutter_stage_set_viewport:
 * @stage: A #ClutterStage
 * @width: The width to render the stage at, in window coordinates
 * @height: The height to render the stage at, in window coordinates
 *
 * Sets the stage viewport. The viewport defines a final scale and
 * translation of your rendered stage and actors. This lets you render
 * your stage into a subregion of the stage window or you could use it to
 * pan a subregion of the stage if your stage window is smaller then
 * the stage. (XXX: currently this isn't possible)
 *
 * Unlike a scale and translation done using the modelview matrix this
 * is done after everything has had perspective projection applied, so
 * for example if you were to pan across a subregion of the stage using
 * the viewport then you would not see a change in perspective for the
 * actors on the stage.
 *
 * Normally the stage viewport will automatically track the size of the
 * stage window with no offset so the stage will fill your window. This
 * behaviour can be changed with the "viewport-mimics-window" property
 * which will automatically be set to FALSE if you use this API. If
 * you want to revert to the original behaviour then you should set
 * this property back to %TRUE using
 * clutter_stage_set_viewport_mimics_window().
 * (XXX: If we were to make this API public then we might want to do
 *  add that property.)
 *
 * Note: currently this interface only support integer precision
 * offsets and sizes for viewports but the interface takes floats because
 * OpenGL 4.0 has introduced floating point viewports which we might
 * want to expose via this API eventually.
 */
static void
clutter_stage_set_viewport (ClutterStage *stage,
                            float         width,
                            float         height)
{
  ClutterStagePrivate *priv;
  float x, y;

  g_return_if_fail (CLUTTER_IS_STAGE (stage));

  priv = clutter_stage_get_instance_private (stage);

  x = 0.f;
  y = 0.f;
  width = roundf (width);
  height = roundf (height);

  if (x == priv->viewport[0] &&
      y == priv->viewport[1] &&
      width == priv->viewport[2] &&
      height == priv->viewport[3])
    return;

  priv->viewport[0] = x;
  priv->viewport[1] = y;
  priv->viewport[2] = width;
  priv->viewport[3] = height;

  clutter_stage_update_view_perspective (stage);
  _clutter_stage_dirty_viewport (stage);

  queue_full_redraw (stage);
}

/* This simply provides a simple mechanism for us to ensure that
 * the viewport gets re-asserted before next painting.
 *
 * This is used when switching between multiple stages */
void
_clutter_stage_dirty_viewport (ClutterStage *stage)
{
  ClutterStagePrivate *priv;
  GList *l;

  g_return_if_fail (CLUTTER_IS_STAGE (stage));

  priv = clutter_stage_get_instance_private (stage);

  for (l = _clutter_stage_window_get_views (priv->impl); l; l = l->next)
    {
      ClutterStageView *view = l->data;

      clutter_stage_view_invalidate_viewport (view);
    }
}

/*
 * clutter_stage_get_viewport:
 * @stage: A #ClutterStage
 * @x: A location for the X position where the stage is rendered,
 *     in window coordinates.
 * @y: A location for the Y position where the stage is rendered,
 *     in window coordinates.
 * @width: A location for the width the stage is rendered at,
 *         in window coordinates.
 * @height: A location for the height the stage is rendered at,
 *          in window coordinates.
 *
 * Returns the viewport offset and size set using
 * clutter_stage_set_viewport() or if the "viewport-mimics-window" property
 * is TRUE then @x and @y will be set to 0 and @width and @height will equal
 * the width if the stage window.
 */
void
_clutter_stage_get_viewport (ClutterStage *stage,
                             float        *x,
                             float        *y,
                             float        *width,
                             float        *height)
{
  ClutterStagePrivate *priv;

  g_return_if_fail (CLUTTER_IS_STAGE (stage));

  priv = clutter_stage_get_instance_private (stage);

  *x = priv->viewport[0];
  *y = priv->viewport[1];
  *width = priv->viewport[2];
  *height = priv->viewport[3];
}

/**
 * clutter_stage_read_pixels:
 * @stage: A #ClutterStage
 * @x: x coordinate of the first pixel that is read from stage
 * @y: y coordinate of the first pixel that is read from stage
 * @width: Width dimension of pixels to be read, or -1 for the
 *   entire stage width
 * @height: Height dimension of pixels to be read, or -1 for the
 *   entire stage height
 *
 * Makes a screenshot of the stage in RGBA 8bit data, returns a
 * linear buffer with @width * 4 as rowstride.
 *
 * The alpha data contained in the returned buffer is driver-dependent,
 * and not guaranteed to hold any sensible value.
 *
 * Return value: (transfer full) (array): a pointer to newly allocated memory with the buffer
 *   or %NULL if the read failed. Use g_free() on the returned data
 *   to release the resources it has allocated.
 */
guchar *
clutter_stage_read_pixels (ClutterStage *stage,
                           gint          x,
                           gint          y,
                           gint          width,
                           gint          height)
{
  ClutterStagePrivate *priv;
  ClutterActorBox box;
  GList *l;
  ClutterStageView *view;
  g_autoptr (MtkRegion) clip = NULL;
  MtkRectangle clip_rect;
  CoglFramebuffer *framebuffer;
  float view_scale;
  float pixel_width;
  float pixel_height;
  uint8_t *pixels;

  COGL_TRACE_BEGIN_SCOPED (ClutterStageReadPixels, "Clutter::Stage::read_pixels()");

  g_return_val_if_fail (CLUTTER_IS_STAGE (stage), NULL);

  priv = clutter_stage_get_instance_private (stage);

  clutter_actor_get_allocation_box (CLUTTER_ACTOR (stage), &box);

  if (width < 0)
    width = (int) ceilf (box.x2 - box.x1);

  if (height < 0)
    height = (int) ceilf (box.y2 - box.y1);

  l = _clutter_stage_window_get_views (priv->impl);

  if (!l)
    return NULL;

  /* XXX: We only read the first view. Needs different API for multi view screen
   * capture. */
  view = l->data;

  clutter_stage_view_get_layout (view, &clip_rect);
  clip = mtk_region_create_rectangle (&clip_rect);
  mtk_region_intersect_rectangle (clip,
                                  &MTK_RECTANGLE_INIT (x, y, width, height));
  clip_rect = mtk_region_get_extents (clip);

  if (clip_rect.width == 0 || clip_rect.height == 0)
    return NULL;

  framebuffer = clutter_stage_view_get_framebuffer (view);
  clutter_stage_do_paint_view (stage, view, NULL, clip);

  view_scale = clutter_stage_view_get_scale (view);
  pixel_width = roundf (clip_rect.width * view_scale);
  pixel_height = roundf (clip_rect.height * view_scale);

  pixels = g_malloc0 ((int) (pixel_width * pixel_height * 4));
  cogl_framebuffer_read_pixels (framebuffer,
                                (int) (clip_rect.x * view_scale),
                                (int) (clip_rect.y * view_scale),
                                (int) pixel_width,
                                (int) pixel_height,
                                COGL_PIXEL_FORMAT_RGBA_8888,
                                pixels);

  return pixels;
}

/**
 * clutter_stage_get_actor_at_pos:
 * @stage: a #ClutterStage
 * @pick_mode: how the scene graph should be painted
 * @x: X coordinate to check
 * @y: Y coordinate to check
 *
 * Checks the scene at the coordinates @x and @y and returns a pointer
 * to the [class@Clutter.Actor] at those coordinates. The result is the actor which
 * would be at the specified location on the next redraw, and is not
 * necessarily that which was there on the previous redraw. This allows the
 * function to perform chronologically correctly after any queued changes to
 * the scene, and even if nothing has been drawn.
 *
 * By using @pick_mode it is possible to control which actors will be
 * painted and thus available.
 *
 * Return value: (transfer none): the actor at the specified coordinates,
 *   if any
 */
ClutterActor *
clutter_stage_get_actor_at_pos (ClutterStage    *stage,
                                ClutterPickMode  pick_mode,
                                float            x,
                                float            y)
{
  g_return_val_if_fail (CLUTTER_IS_STAGE (stage), NULL);

  return _clutter_stage_do_pick (stage, x, y, pick_mode, NULL);
}

/**
 * clutter_stage_set_key_focus:
 * @stage: the #ClutterStage
 * @actor: (allow-none): the actor to set key focus to, or %NULL
 *
 * Sets the key focus on @actor. An actor with key focus will receive
 * all the key events. If @actor is %NULL, the stage will receive
 * focus.
 */
void
clutter_stage_set_key_focus (ClutterStage *stage,
                             ClutterActor *actor)
{
  ClutterContext *context;
  ClutterBackend *backend;
  ClutterKeyFocus *key_focus;

  g_return_if_fail (CLUTTER_IS_STAGE (stage));
  g_return_if_fail (actor == NULL || CLUTTER_IS_ACTOR (actor));

  context = clutter_actor_get_context (CLUTTER_ACTOR (stage));
  backend = clutter_context_get_backend (context);
  key_focus = clutter_backend_get_key_focus (backend, stage);

  /* normalize the key focus. NULL == stage */
  if (actor == CLUTTER_ACTOR (stage))
    {
      g_warning ("Stage key focus was set to stage itself, "
                 "unsetting focus instead");
      actor = NULL;
    }

  if (clutter_focus_set_current_actor (CLUTTER_FOCUS (key_focus),
                                       actor, NULL,
                                       CLUTTER_CURRENT_TIME))
    g_object_notify_by_pspec (G_OBJECT (stage), obj_props[PROP_KEY_FOCUS]);
}

/**
 * clutter_stage_get_key_focus:
 * @stage: the #ClutterStage
 *
 * Retrieves the actor that is currently under key focus.
 *
 * Return value: (transfer none) (nullable): the actor with key focus
 */
ClutterActor *
clutter_stage_get_key_focus (ClutterStage *stage)
{
  ClutterContext *context;
  ClutterBackend *backend;
  ClutterKeyFocus *key_focus;

  g_return_val_if_fail (CLUTTER_IS_STAGE (stage), NULL);

  context = clutter_actor_get_context (CLUTTER_ACTOR (stage));
  backend = clutter_context_get_backend (context);
  key_focus = clutter_backend_get_key_focus (backend, stage);
  if (!key_focus)
    return NULL;

  return clutter_focus_get_current_actor (CLUTTER_FOCUS (key_focus));
}

/*** Perspective boxed type ******/

static gpointer
clutter_perspective_copy (gpointer data)
{
  if (G_LIKELY (data))
    return g_memdup2 (data, sizeof (ClutterPerspective));

  return NULL;
}

static void
clutter_perspective_free (gpointer data)
{
  if (G_LIKELY (data))
    g_free (data);
}

G_DEFINE_BOXED_TYPE (ClutterPerspective, clutter_perspective,
                     clutter_perspective_copy,
                     clutter_perspective_free);

/**
 * clutter_stage_ensure_viewport:
 * @stage: a #ClutterStage
 *
 * Ensures that the GL viewport is updated with the current
 * stage window size.
 *
 * This function will queue a redraw of @stage.
 *
 * This function should not be called by applications; it is used
 * when embedding a #ClutterStage into a toolkit with another
 * windowing system, like GTK+.
 */
void
clutter_stage_ensure_viewport (ClutterStage *stage)
{
  g_return_if_fail (CLUTTER_IS_STAGE (stage));

  _clutter_stage_dirty_viewport (stage);

  clutter_actor_queue_redraw (CLUTTER_ACTOR (stage));
}

# define _DEG_TO_RAD(d)         ((d) * ((float) G_PI / 180.0f))

/* This calculates a distance into the view frustum to position the
 * stage so there is a decent amount of space to position geometry
 * between the stage and the near clipping plane.
 *
 * Some awkward issues with this problem are:
 * - It's not possible to have a gap as large as the stage size with
 *   a fov > 53° which is basically always the case since the default
 *   fov is 60°.
 *    - This can be deduced if you consider that this requires a
 *      triangle as wide as it is deep to fit in the frustum in front
 *      of the z_near plane. That triangle will always have an angle
 *      of 53.13° at the point sitting on the z_near plane, but if the
 *      frustum has a wider fov angle the left/right clipping planes
 *      can never converge with the two corners of our triangle no
 *      matter what size the triangle has.
 * - With a fov > 53° there is a trade off between maximizing the gap
 *   size relative to the stage size but not losing depth precision.
 * - Perhaps ideally we wouldn't just consider the fov on the y-axis
 *   that is usually used to define a perspective, we would consider
 *   the fov of the axis with the largest stage size so the gap would
 *   accommodate that size best.
 *
 * After going around in circles a few times with how to handle these
 * issues, we decided in the end to go for the simplest solution to
 * start with instead of an elaborate function that handles arbitrary
 * fov angles that we currently have no use-case for.
 *
 * The solution assumes a fovy of 60° and for that case gives a gap
 * that's 85% of the stage height. We can consider more elaborate
 * functions if necessary later.
 *
 * One guide we had to steer the gap size we support is the
 * interactive test, test-texture-quality which expects to animate an
 * actor to +400 on the z axis with a stage size of 640x480. A gap
 * that's 85% of the stage height gives a gap of 408 in that case.
 */
static float
calculate_z_translation (float z_near)
{
  /* This solution uses fairly basic trigonometry, but is seems worth
   * clarifying the particular geometry we are looking at in-case
   * anyone wants to develop this further later. Not sure how well an
   * ascii diagram is going to work :-)
   *
   *    |--- stage_height ---|
   *    |     stage line     |
   *   ╲━━━━━━━━━━━━━━━━━━━━━╱------------
   *    ╲.  (2)   │        .╱       |   |
   *   C ╲ .      │      . ╱     gap|   |
   * =0.5°╲  . a  │    .  ╱         |   |
   *      b╲(1). D│  .   ╱          |   |
   *        ╲   B.│.    ╱near plane |   |
   *      A= ╲━━━━━━━━━╱-------------   |
   *     120° ╲ c │   ╱  |            z_2d
   *           ╲  │  ╱  z_near          |
   *       left ╲ │ ╱    |              |
   *       clip  60°fovy |              |
   *       plane  ╳----------------------
   *              |
   *              |
   *         origin line
   *
   * The area of interest is the triangle labeled (1) at the top left
   * marked with the ... line (a) from where the origin line crosses
   * the near plane to the top left where the stage line cross the
   * left clip plane.
   *
   * The sides of the triangle are a, b and c and the corresponding
   * angles opposite those sides are A, B and C.
   *
   * The angle of C is what trades off the gap size we have relative
   * to the stage size vs the depth precision we have.
   *
   * As mentioned above we arove at the angle for C is by working
   * backwards from how much space we want for test-texture-quality.
   * With a stage_height of 480 we want a gap > 400, ideally we also
   * wanted a somewhat round number as a percentage of the height for
   * documentation purposes. ~87% or a gap of ~416 is the limit
   * because that's where we approach a C angle of 0° and effectively
   * loose all depth precision.
   *
   * So for our test app with a stage_height of 480 if we aim for a
   * gap of 408 (85% of 480) we can get the angle D as
   * atan (stage_height/2/408) = 30.5°.
   *
   * That gives us the angle for B as 90° - 30.5° = 59.5°
   *
   * We can already determine that A has an angle of (fovy/2 + 90°) =
   * 120°
   *
   * Therefore C = 180 - A - B = 0.5°
   *
   * The length of c = z_near * tan (30°)
   *
   * Now we can use the rule a/SinA = c/SinC to calculate the
   * length of a. After some rearranging that gives us:
   *
   *      a              c
   *  ----------  =  ----------
   *  sin (120°)     sin (0.5°)
   *
   *      c * sin (120°)
   *  a = --------------
   *        sin (0.5°)
   *
   * And with that we can determine z_2d = cos (D) * a =
   * cos (30.5°) * a + z_near:
   *
   *         c * sin (120°) * cos (30.5°)
   *  z_2d = --------------------------- + z_near
   *                 sin (0.5°)
   */

   /* We expect the compiler should boil this down to z_near * CONSTANT
    * already, but just in case we use precomputed constants
    */
#if 0
# define A      tanf (_DEG_TO_RAD (30.f))
# define B      sinf (_DEG_TO_RAD (120.f))
# define C      cosf (_DEG_TO_RAD (30.5f))
# define D      sinf (_DEG_TO_RAD (.5f))
#else
# define A      0.57735025882720947265625f
# define B      0.866025388240814208984375f
# define C      0.86162912845611572265625f
# define D      0.00872653536498546600341796875f
#endif

  return z_near
       * A * B * C
       / D
       + z_near;
}

static void
view_2d_in_perspective (graphene_matrix_t *matrix,
                        float              fov_y,
                        float              aspect,
                        float              z_near,
                        float              z_2d,
                        float              width_2d,
                        float              height_2d)
{
  float top = z_near * tanf ((float) (fov_y * G_PI / 360.0f));
  float left = -top * aspect;
  float right = top * aspect;
  float bottom = -top;

  float left_2d_plane = left / z_near * z_2d;
  float right_2d_plane = right / z_near * z_2d;
  float bottom_2d_plane = bottom / z_near * z_2d;
  float top_2d_plane = top / z_near * z_2d;

  float width_2d_start = right_2d_plane - left_2d_plane;
  float height_2d_start = top_2d_plane - bottom_2d_plane;

  /* Factors to scale from framebuffer geometry to frustum
   * cross-section geometry. */
  float width_scale = width_2d_start / width_2d;
  float height_scale = height_2d_start / height_2d;

  graphene_matrix_init_scale (matrix, width_scale, -height_scale, width_scale);
  graphene_matrix_translate (matrix,
                             &GRAPHENE_POINT3D_INIT (left_2d_plane,
                                                     top_2d_plane,
                                                     -z_2d));
}

static void
clutter_stage_update_view_perspective (ClutterStage *stage)
{
  ClutterStagePrivate *priv = clutter_stage_get_instance_private (stage);
  ClutterPerspective perspective;
  float z_2d;

  perspective = priv->perspective;

  perspective.fovy = 60.0; /* 60 Degrees */
  perspective.z_near = 1.0;
  perspective.aspect = priv->viewport[2] / priv->viewport[3];
  z_2d = calculate_z_translation (perspective.z_near);

  /* NB: z_2d is only enough room for 85% of the stage_height between
   * the stage and the z_near plane. For behind the stage plane we
   * want a more consistent gap of 10 times the stage_height before
   * hitting the far plane so we calculate that relative to the final
   * height of the stage plane at the z_2d_distance we got... */
  perspective.z_far = z_2d +
    tanf (_DEG_TO_RAD (perspective.fovy / 2.0f)) * z_2d * 20.0f;

  clutter_stage_set_perspective (stage, &perspective);

  view_2d_in_perspective (&priv->view,
                          perspective.fovy,
                          perspective.aspect,
                          perspective.z_near,
                          z_2d,
                          priv->viewport[2],
                          priv->viewport[3]);

  clutter_actor_invalidate_transform (CLUTTER_ACTOR (stage));
}

/* Round the exact (possibly fractional) viewport to integers for GL, folding
 * the rounding remainder into the returned projection so the combined transform
 * stays pixel-exact. */
static void
clutter_stage_calculate_viewport_and_projection (const graphene_matrix_t *projection,
                                                 const float              exact_viewport[4],
                                                 float                    viewport[4],
                                                 graphene_matrix_t       *out_projection)
{
  float phase_x, phase_y;
  float scale_x, scale_y;
  graphene_matrix_t scale;
  graphene_matrix_t translate;
  graphene_matrix_t correction;

  viewport[0] = roundf (exact_viewport[0]);
  viewport[1] = roundf (exact_viewport[1]);
  viewport[2] = roundf (exact_viewport[2]);
  viewport[3] = roundf (exact_viewport[3]);

  if (viewport[2] <= 0.f || viewport[3] <= 0.f)
    {
      *out_projection = *projection;
      return;
    }

  phase_x = exact_viewport[0] - viewport[0];
  phase_y = exact_viewport[1] - viewport[1];
  scale_x = exact_viewport[2] / viewport[2];
  scale_y = exact_viewport[3] / viewport[3];

  if (phase_x == 0.f && phase_y == 0.f &&
      scale_x == 1.f && scale_y == 1.f)
    {
      *out_projection = *projection;
      return;
    }

  graphene_matrix_init_scale (&scale, scale_x, scale_y, 1.f);
  graphene_matrix_init_translate (
    &translate,
    &GRAPHENE_POINT3D_INIT (scale_x - 1.f + 2.f * phase_x / viewport[2],
                            1.f - scale_y - 2.f * phase_y / viewport[3],
                            0.f));
  graphene_matrix_multiply (&scale, &translate, &correction);
  graphene_matrix_multiply (projection, &correction, out_projection);
}

void
_clutter_stage_maybe_setup_viewport (ClutterStage     *stage,
                                     ClutterStageView *view)
{
  ClutterStagePrivate *priv = clutter_stage_get_instance_private (stage);
  MtkRectangle view_layout;
  float fb_scale;
  float exact_viewport[4];
  float viewport[4];
  graphene_matrix_t projection;

  if (!clutter_stage_view_is_dirty_viewport (view) &&
      !clutter_stage_view_is_dirty_projection (view))
    return;

  fb_scale = clutter_stage_view_get_scale (view);
  clutter_stage_view_get_layout (view, &view_layout);

  exact_viewport[0] = priv->viewport[0] * fb_scale - view_layout.x * fb_scale;
  exact_viewport[1] = priv->viewport[1] * fb_scale - view_layout.y * fb_scale;
  exact_viewport[2] = priv->viewport[2] * fb_scale;
  exact_viewport[3] = priv->viewport[3] * fb_scale;

  clutter_stage_calculate_viewport_and_projection (&priv->projection,
                                                   exact_viewport,
                                                   viewport,
                                                   &projection);

  if (clutter_stage_view_is_dirty_viewport (view))
    {
      CLUTTER_NOTE (PAINT,
                    "Setting up the viewport { w:%f, h:%f }",
                    priv->viewport[2],
                    priv->viewport[3]);

      clutter_stage_view_set_viewport (view,
                                       viewport[0], viewport[1],
                                       viewport[2], viewport[3]);

      /* The projection embeds the viewport phase; keep them in sync */
      clutter_stage_view_invalidate_projection (view);
    }

  if (clutter_stage_view_is_dirty_projection (view))
    clutter_stage_view_set_projection (view, &projection);
}

#undef _DEG_TO_RAD

/**
 * clutter_stage_is_redraw_queued_on_view: (skip)
 */
gboolean
clutter_stage_is_redraw_queued_on_view (ClutterStage     *stage,
                                        ClutterStageView *view)
{
  clutter_stage_finish_layout (stage);

  return clutter_stage_view_has_redraw_clip (view);
}

void
_clutter_stage_set_window (ClutterStage       *stage,
                           ClutterStageWindow *stage_window)
{
  ClutterStagePrivate *priv;

  g_return_if_fail (CLUTTER_IS_STAGE (stage));
  g_return_if_fail (CLUTTER_IS_STAGE_WINDOW (stage_window));

  priv = clutter_stage_get_instance_private (stage);

  if (priv->impl != NULL)
    g_object_unref (priv->impl);

  priv->impl = stage_window;
}

ClutterStageWindow *
_clutter_stage_get_window (ClutterStage *stage)
{
  ClutterStagePrivate *priv;

  g_return_val_if_fail (CLUTTER_IS_STAGE (stage), NULL);

  priv = clutter_stage_get_instance_private (stage);

  return CLUTTER_STAGE_WINDOW (priv->impl);
}

/**
 * clutter_stage_schedule_update:
 * @stage: a #ClutterStage actor
 *
 * Schedules a redraw of the #ClutterStage at the next optimal timestamp.
 */
void
clutter_stage_schedule_update (ClutterStage *stage)
{
  ClutterStagePrivate *priv = clutter_stage_get_instance_private (stage);
  ClutterStageWindow *stage_window;
  gboolean first_event;
  GList *l;

  if (CLUTTER_ACTOR_IN_DESTRUCTION (stage))
    return;

  first_event = priv->event_queue->length == 0;

  if (priv->update_scheduled && !first_event)
    return;

  stage_window = _clutter_stage_get_window (stage);
  if (stage_window == NULL)
    return;

  for (l = clutter_stage_peek_stage_views (stage); l; l = l->next)
    {
      ClutterStageView *view = l->data;

      clutter_stage_view_schedule_update (view);
    }

  priv->update_scheduled = TRUE;
}

void
clutter_stage_add_to_redraw_clip (ClutterStage       *stage,
                                  ClutterPaintVolume *redraw_clip)
{
  ClutterStageWindow *stage_window;
  ClutterActorBox bounding_box;
  ClutterActorBox intersection_box;
  MtkRectangle geom, stage_clip;

  if (CLUTTER_ACTOR_IN_DESTRUCTION (CLUTTER_ACTOR (stage)))
    return;

  stage_window = _clutter_stage_get_window (stage);
  if (stage_window == NULL)
    return;

  if (is_full_stage_redraw_queued (stage))
    return;

  if (redraw_clip == NULL)
    {
      clutter_stage_add_redraw_clip (stage, NULL);
      return;
    }

  if (redraw_clip->is_empty)
    return;

  /* Now transform and project the clip volume to view coordinates and get
   * the axis aligned bounding box that's aligned to the pixel grid.
   */
  _clutter_paint_volume_get_stage_paint_box (redraw_clip,
                                             stage,
                                             &bounding_box);

  _clutter_stage_window_get_geometry (stage_window, &geom);

  intersection_box.x1 = MAX (bounding_box.x1, 0);
  intersection_box.y1 = MAX (bounding_box.y1, 0);
  intersection_box.x2 = MIN (bounding_box.x2, geom.width);
  intersection_box.y2 = MIN (bounding_box.y2, geom.height);

  /* There is no need to track degenerate/empty redraw clips */
  if (intersection_box.x2 <= intersection_box.x1 ||
      intersection_box.y2 <= intersection_box.y1)
    return;

  stage_clip.x = (int) intersection_box.x1;
  stage_clip.y = (int) intersection_box.y1;
  stage_clip.width = (int) (intersection_box.x2 - stage_clip.x);
  stage_clip.height = (int) (intersection_box.y2 - stage_clip.y);

  clutter_stage_add_redraw_clip (stage, &stage_clip);
}

int64_t
clutter_stage_get_frame_counter (ClutterStage          *stage)
{
  ClutterStageWindow *stage_window;

  stage_window = _clutter_stage_get_window (stage);
  return _clutter_stage_window_get_frame_counter (stage_window);
}

void
clutter_stage_presented (ClutterStage     *stage,
                         ClutterStageView *view,
                         ClutterFrameInfo *frame_info)
{
  g_signal_emit (stage, stage_signals[PRESENTED], 0, view, frame_info);
}

/**
 * clutter_stage_get_capture_final_size:
 * @stage: a #ClutterStage actor
 * @rect: a rectangle
 * @out_width: (out) (optional): the final width
 * @out_height: (out) (optional): the final height
 * @out_scale: (out) (optional): the final scale factor
 *
 * Get the size of the framebuffer one must pass to
 * [method@Stage.paint_to_buffer] or [method@Stage.paint_to_framebuffer]
 * would be used with the same @rect.
 *
 * Returns: %TRUE if the size has been retrieved, %FALSE otherwise.
 */
gboolean
clutter_stage_get_capture_final_size (ClutterStage *stage,
                                      MtkRectangle *rect,
                                      int          *out_width,
                                      int          *out_height,
                                      float        *out_scale)
{
  float max_scale = 1.0;

  g_return_val_if_fail (CLUTTER_IS_STAGE (stage), FALSE);

  if (rect)
    {
      graphene_rect_t capture_rect;
      g_autoptr (GList) views = NULL;
      GList *l;

      capture_rect = mtk_rectangle_to_graphene_rect (rect);
      views = clutter_stage_get_views_for_rect (stage, &capture_rect);

      if (!views)
        return FALSE;

      for (l = views; l; l = l->next)
        {
          ClutterStageView *view = l->data;

          max_scale = MAX (clutter_stage_view_get_scale (view), max_scale);
        }

      if (out_width)
        *out_width = (gint) roundf (rect->width * max_scale);

      if (out_height)
        *out_height = (gint) roundf (rect->height * max_scale);
    }
  else
    {
      ClutterActorBox alloc;
      float stage_width, stage_height;

      clutter_actor_get_allocation_box (CLUTTER_ACTOR (stage), &alloc);
      clutter_actor_box_get_size (&alloc, &stage_width, &stage_height);
      max_scale = clutter_actor_get_real_resource_scale (CLUTTER_ACTOR (stage));

      if (out_width)
        *out_width = (gint) roundf (stage_width * max_scale);

      if (out_height)
        *out_height = (gint) roundf (stage_height * max_scale);
    }

  if (out_scale)
    *out_scale = max_scale;

  return TRUE;
}

void
clutter_stage_paint_to_framebuffer (ClutterStage       *stage,
                                    CoglFramebuffer    *framebuffer,
                                    const MtkRectangle *rect,
                                    float               scale,
                                    ClutterColorState  *color_state,
                                    ClutterPaintFlag    paint_flags)
{
  ClutterStagePrivate *priv = clutter_stage_get_instance_private (stage);
  ClutterPaintContext *paint_context;
  g_autoptr (MtkRegion) redraw_clip = NULL;
  float exact_viewport[4];
  float viewport[4];
  graphene_matrix_t projection;

  COGL_TRACE_BEGIN_SCOPED (PaintToFramebuffer,
                           "Clutter::Stage::paint_to_framebuffer()");

  if (paint_flags & CLUTTER_PAINT_FLAG_CLEAR)
    {
      CoglColor clear_color;

      cogl_color_init_from_4f (&clear_color, 0.0, 0.0, 0.0, 0.0);
      cogl_framebuffer_clear (framebuffer, COGL_BUFFER_BIT_COLOR, &clear_color);
    }

  redraw_clip = mtk_region_create_rectangle (rect);

  if (!color_state)
    color_state = clutter_actor_get_color_state (CLUTTER_ACTOR (stage));

  paint_context =
    clutter_paint_context_new_for_framebuffer (framebuffer,
                                               redraw_clip,
                                               paint_flags,
                                               color_state);

  exact_viewport[0] = -(rect->x * scale);
  exact_viewport[1] = -(rect->y * scale);
  exact_viewport[2] = priv->viewport[2] * scale;
  exact_viewport[3] = priv->viewport[3] * scale;
  clutter_stage_calculate_viewport_and_projection (&priv->projection,
                                                   exact_viewport,
                                                   viewport,
                                                   &projection);

  cogl_framebuffer_push_matrix (framebuffer);
  cogl_framebuffer_set_projection_matrix (framebuffer, &projection);
  cogl_framebuffer_set_viewport (framebuffer,
                                 viewport[0], viewport[1],
                                 viewport[2], viewport[3]);
  clutter_actor_paint (CLUTTER_ACTOR (stage), paint_context);
  cogl_framebuffer_pop_matrix (framebuffer);

  clutter_paint_context_destroy (paint_context);

  cogl_framebuffer_flush (framebuffer);
}

/**
 * clutter_stage_paint_to_buffer:
 * @stage: a #ClutterStage actor
 * @rect: a rectangle
 * @scale: the scale
 * @data: (array) (element-type guint8): a pointer to the data
 * @stride: stride of the image surface
 * @format: the pixel format
 * @color_state: (nullable): the #ClutterColorState
 * @paint_flags: the #ClutterPaintFlag
 * @error: the error
 *
 * Take a snapshot of the stage to a provided buffer.
 *
 * Returns: %TRUE is the buffer has been paint successfully, %FALSE otherwise.
 */
gboolean
clutter_stage_paint_to_buffer (ClutterStage        *stage,
                               const MtkRectangle  *rect,
                               float                scale,
                               uint8_t             *data,
                               int                  stride,
                               CoglPixelFormat      format,
                               ClutterColorState   *color_state,
                               ClutterPaintFlag     paint_flags,
                               GError             **error)
{
  ClutterContext *context =
    clutter_actor_get_context (CLUTTER_ACTOR (stage));
  ClutterBackend *clutter_backend = clutter_context_get_backend (context);
  CoglContext *cogl_context =
    clutter_backend_get_cogl_context (clutter_backend);
  int texture_width, texture_height;
  CoglTexture *texture;
  CoglOffscreen *offscreen;
  CoglFramebuffer *framebuffer;
  CoglBitmap *bitmap;

  texture_width = (int) roundf (rect->width * scale);
  texture_height = (int) roundf (rect->height * scale);
  texture = cogl_texture_2d_new_with_size (cogl_context,
                                           texture_width,
                                           texture_height);
  if (!texture)
    {
      g_set_error (error, G_IO_ERROR, G_IO_ERROR_FAILED,
                   "Failed to create %dx%d texture",
                   texture_width, texture_height);
      return FALSE;
    }

  offscreen = cogl_offscreen_new_with_texture (texture);
  framebuffer = COGL_FRAMEBUFFER (offscreen);

  g_object_unref (texture);

  if (!cogl_framebuffer_allocate (framebuffer, error))
    return FALSE;

  clutter_stage_paint_to_framebuffer (stage, framebuffer,
                                      rect, scale,
                                      color_state,
                                      paint_flags);

  bitmap = cogl_bitmap_new_for_data (cogl_context,
                                     texture_width, texture_height,
                                     format,
                                     stride,
                                     data);

  cogl_framebuffer_read_pixels_into_bitmap (framebuffer,
                                            0, 0,
                                            COGL_READ_PIXELS_COLOR_BUFFER,
                                            bitmap);

  g_object_unref (bitmap);
  g_object_unref (framebuffer);

  return TRUE;
}

/**
 * clutter_stage_paint_to_content:
 * @stage: a #ClutterStage actor
 * @rect: a rectangle
 * @scale: the scale
 * @color_state: (nullable): the #ClutterColorState
 * @paint_flags: the #ClutterPaintFlag
 * @error: the error
 *
 * Take a snapshot of the stage to a #ClutterContent.
 *
 * Returns: (transfer full): the #ClutterContent or %NULL on error.
 */
ClutterContent *
clutter_stage_paint_to_content (ClutterStage        *stage,
                                const MtkRectangle  *rect,
                                float                scale,
                                ClutterColorState   *color_state,
                                ClutterPaintFlag     paint_flags,
                                GError             **error)
{
  ClutterContext *context =
    clutter_actor_get_context (CLUTTER_ACTOR (stage));
  ClutterBackend *clutter_backend = clutter_context_get_backend (context);
  CoglContext *cogl_context =
    clutter_backend_get_cogl_context (clutter_backend);
  int texture_width, texture_height;
  CoglTexture *texture;
  CoglOffscreen *offscreen;
  g_autoptr (CoglFramebuffer) framebuffer = NULL;

  texture_width = (int) roundf (rect->width * scale);
  texture_height = (int) roundf (rect->height * scale);
  texture = cogl_texture_2d_new_with_size (cogl_context,
                                           texture_width,
                                           texture_height);
  if (!texture)
    {
      g_set_error (error, G_IO_ERROR, G_IO_ERROR_FAILED,
                   "Failed to create %dx%d texture",
                   texture_width, texture_height);
      return NULL;
    }

  offscreen = cogl_offscreen_new_with_texture (texture);
  framebuffer = COGL_FRAMEBUFFER (offscreen);

  g_object_unref (texture);

  if (!cogl_framebuffer_allocate (framebuffer, error))
    return NULL;

  clutter_stage_paint_to_framebuffer (stage, framebuffer,
                                      rect, scale,
                                      color_state,
                                      paint_flags);

  return clutter_texture_content_new_from_texture (cogl_offscreen_get_texture (offscreen),
                                                   NULL);
}

void
clutter_stage_capture_view_into (ClutterStage     *stage,
                                 ClutterStageView *view,
                                 MtkRectangle     *rect,
                                 uint8_t          *data,
                                 int               stride)
{
  CoglFramebuffer *framebuffer;
  ClutterBackend *backend;
  ClutterContext *clutter_context;
  CoglContext *context;
  CoglBitmap *bitmap;
  MtkRectangle view_layout;
  float view_scale;
  float texture_width;
  float texture_height;

  g_return_if_fail (CLUTTER_IS_STAGE (stage));

  framebuffer = clutter_stage_view_get_framebuffer (view);

  clutter_stage_view_get_layout (view, &view_layout);

  if (!rect)
    rect = &view_layout;

  view_scale = clutter_stage_view_get_scale (view);
  texture_width = roundf (rect->width * view_scale);
  texture_height = roundf (rect->height * view_scale);

  clutter_context = clutter_actor_get_context (CLUTTER_ACTOR (stage));
  backend = clutter_context_get_backend (clutter_context);
  context = clutter_backend_get_cogl_context (backend);
  bitmap = cogl_bitmap_new_for_data (context,
                                     (int) texture_width,
                                     (int) texture_height,
                                     COGL_PIXEL_FORMAT_CAIRO_ARGB32_COMPAT,
                                     stride,
                                     data);

  cogl_framebuffer_read_pixels_into_bitmap (framebuffer,
                                            (int) roundf ((rect->x -
                                                           view_layout.x) * view_scale),
                                            (int) roundf ((rect->y -
                                                           view_layout.y) * view_scale),
                                            COGL_READ_PIXELS_COLOR_BUFFER,
                                            bitmap);

  g_object_unref (bitmap);
}

/**
 * clutter_stage_peek_stage_views: (skip)
 */
GList *
clutter_stage_peek_stage_views (ClutterStage *stage)
{
  ClutterStagePrivate *priv = clutter_stage_get_instance_private (stage);

  return _clutter_stage_window_get_views (priv->impl);
}

void
clutter_stage_clear_stage_views (ClutterStage *stage)
{
  clutter_actor_clear_stage_views_recursive (CLUTTER_ACTOR (stage), FALSE);
}

GList *
clutter_stage_get_views_for_rect (ClutterStage          *stage,
                                  const graphene_rect_t *rect)
{
  ClutterStagePrivate *priv = clutter_stage_get_instance_private (stage);
  GList *views_for_rect = NULL;
  GList *l;

  for (l = _clutter_stage_window_get_views (priv->impl); l; l = l->next)
    {
      ClutterStageView *view = l->data;
      MtkRectangle view_layout;
      graphene_rect_t view_rect;

      clutter_stage_view_get_layout (view, &view_layout);
      view_rect = mtk_rectangle_to_graphene_rect (&view_layout);

      if (graphene_rect_intersection (&view_rect, rect, NULL))
        views_for_rect = g_list_prepend (views_for_rect, view);
    }

  return views_for_rect;
}

void
clutter_stage_set_actor_needs_immediate_relayout (ClutterStage *stage)
{
  ClutterStagePrivate *priv = clutter_stage_get_instance_private (stage);

  priv->actor_needs_immediate_relayout = TRUE;
}

static gboolean
invalidate_focus_foreach_cb (ClutterStage  *self,
                             ClutterSprite *sprite,
                             gpointer       user_data)
{
  ClutterActor *actor = user_data;

  if (clutter_focus_get_current_actor (CLUTTER_FOCUS (sprite)) == actor)
    {
      graphene_point_t coords;

      clutter_sprite_get_coords (sprite, &coords);
      clutter_stage_pick_and_update_sprite (self,
                                            sprite,
                                            NULL,
                                            CLUTTER_DEVICE_UPDATE_IGNORE_CACHE,
                                            coords,
                                            CLUTTER_CURRENT_TIME);
    }

  return TRUE;
}

void
clutter_stage_maybe_invalidate_focus (ClutterStage *self,
                                      ClutterActor *actor)
{
  if (CLUTTER_ACTOR_IN_DESTRUCTION (self))
    return;

  clutter_stage_foreach_sprite (self, invalidate_focus_foreach_cb, actor);
}

void
clutter_stage_invalidate_focus (ClutterStage *self,
                                ClutterActor *actor)
{
  if (CLUTTER_ACTOR_IN_DESTRUCTION (self))
    return;

  g_assert (!clutter_actor_is_mapped (actor) || !clutter_actor_get_reactive (actor));

  clutter_stage_maybe_invalidate_focus (self, actor);

  if (actor != CLUTTER_ACTOR (self))
    g_assert (!clutter_actor_has_pointer (actor));
}

static void
clutter_stage_pick_and_update_sprite (ClutterStage             *stage,
                                      ClutterSprite            *sprite,
                                      ClutterInputDevice       *source_device,
                                      ClutterDeviceUpdateFlags  flags,
                                      graphene_point_t          point,
                                      uint32_t                  time_ms)
{
  ClutterContext *context =
    clutter_actor_get_context (CLUTTER_ACTOR (stage));
  ClutterBackend *backend =
    clutter_context_get_backend (context);
  ClutterSeat *seat =
    clutter_backend_get_default_seat (backend);
  ClutterActor *new_actor = NULL;
  MtkRegion *clear_area = NULL;

  if (sprite != clutter_backend_get_pointer_sprite (backend, stage) ||
      clutter_seat_is_unfocus_inhibited (seat))
    {
      if ((flags & CLUTTER_DEVICE_UPDATE_IGNORE_CACHE) == 0)
        {
          if (clutter_sprite_point_in_clear_area (sprite, point))
            {
              clutter_sprite_update_coords (sprite, point);
              return;
            }
        }

      new_actor = _clutter_stage_do_pick (stage,
                                          point.x,
                                          point.y,
                                          CLUTTER_PICK_REACTIVE,
                                          &clear_area);

      /* Picking should never fail, but if it does, we bail out here */
      g_return_if_fail (new_actor != NULL);
    }

  clutter_sprite_update (sprite, point, clear_area);
  clutter_focus_set_current_actor (CLUTTER_FOCUS (sprite), new_actor,
                                   source_device, time_ms);

  g_clear_pointer (&clear_area, mtk_region_unref);
}

static gboolean
notify_grab_foreach_cb (ClutterStage  *self,
                        ClutterSprite *sprite,
                        gpointer       user_data)
{
  ClutterStagePrivate *priv = clutter_stage_get_instance_private (self);
  ClutterGrab *old = user_data;

  clutter_focus_notify_grab (CLUTTER_FOCUS (sprite),
                             priv->topmost_grab,
                             priv->topmost_grab ?
                             priv->topmost_grab->actor : NULL,
                             old ? old->actor : NULL);
  return TRUE;
}

static void
clutter_stage_notify_grab (ClutterStage *stage,
                           ClutterGrab  *cur,
                           ClutterGrab  *old)
{
  ClutterStagePrivate *priv = clutter_stage_get_instance_private (stage);
  ClutterActor *cur_actor = NULL, *old_actor = NULL;
  ClutterContext *context;
  ClutterBackend *backend;
  ClutterKeyFocus *key_focus;

  if (cur)
    cur_actor = cur->actor;
  if (old)
    old_actor = old->actor;

  /* Nothing to notify */
  if (cur_actor == old_actor)
    return;

  clutter_stage_foreach_sprite (stage, notify_grab_foreach_cb, old);

  context = clutter_actor_get_context (CLUTTER_ACTOR (stage));
  backend = clutter_context_get_backend (context);
  key_focus = clutter_backend_get_key_focus (backend, stage);
  clutter_focus_notify_grab (CLUTTER_FOCUS (key_focus),
                             priv->topmost_grab,
                             cur_actor,
                             old_actor);
}

static ClutterGrab *
clutter_stage_grab_full (ClutterStage *stage,
                         ClutterActor *actor,
                         gboolean      owns_actor)
{
  g_return_val_if_fail (CLUTTER_IS_STAGE (stage), NULL);
  g_return_val_if_fail (CLUTTER_IS_ACTOR (actor), NULL);
  g_return_val_if_fail (stage ==
                        (ClutterStage *) _clutter_actor_get_stage_internal (actor),
                        NULL);

  return clutter_grab_new (stage, actor, owns_actor);
}

/**
 * clutter_grab_activate:
 * @grab: a `ClutterGrab`
 *
 * Activates a grab onto its assigned actor. Events will be propagated as
 * usual inside its hierarchy. Activating an already active grab will have
 * no side effects.
 *
 * This method is necessary for grabs obtained through
 * [method@Stage.grab_inactive]. Grabs obtained through [method@Stage.grab]
 * will be activated implicitly.
 *
 * to undo the effects of this function, call [method@Grab.dismiss].
 **/
void
clutter_grab_activate (ClutterGrab *grab)
{
  ClutterStage *stage;
  ClutterStagePrivate *priv;
  gboolean was_grabbed;

  g_return_if_fail (CLUTTER_IS_GRAB (grab));

  stage = grab->stage;
  priv = clutter_stage_get_instance_private (stage);

  /* This grab is already active */
  if (grab->prev || grab->next || priv->topmost_grab == grab)
    return;

  grab->prev = NULL;
  grab->next = priv->topmost_grab;

  was_grabbed = !!priv->topmost_grab;

  if (priv->topmost_grab)
    priv->topmost_grab->prev = grab;

  priv->topmost_grab = grab;

  if (G_UNLIKELY (clutter_debug_flags & CLUTTER_DEBUG_GRABS))
    {
      unsigned int n_grabs = 0;
      ClutterGrab *g;

      for (g = priv->topmost_grab; g != NULL; g = g->next)
        n_grabs++;

      CLUTTER_NOTE (GRABS,
                    "[grab=%p] Attached seat grab (n_grabs: %u) on actor: %s",
                    grab, n_grabs, _clutter_actor_get_debug_name (grab->actor));
    }

  clutter_actor_attach_grab (grab->actor, grab);
  clutter_stage_notify_grab (stage, grab, grab->next);

  if (was_grabbed != !!priv->topmost_grab)
    g_object_notify_by_pspec (G_OBJECT (stage), obj_props[PROP_IS_GRABBED]);

  if (grab->next)
    clutter_grab_notify (grab->next);
}

/**
 * clutter_stage_grab:
 * @stage: The #ClutterStage
 * @actor: The actor grabbing input
 *
 * Grabs input onto a certain actor. Events will be propagated as
 * usual inside its hierarchy.
 *
 * Returns: (transfer full): an opaque #ClutterGrab handle, drop
 *   with [method@Grab.dismiss]
 **/
ClutterGrab *
clutter_stage_grab (ClutterStage *stage,
                    ClutterActor *actor)
{
  ClutterGrab *grab;

  grab = clutter_stage_grab_full (stage, actor, FALSE);
  clutter_grab_activate (grab);

  return grab;
}

/**
 * clutter_stage_grab_inactive:
 * @stage: The #ClutterStage
 * @actor: The actor that will grab input
 *
 * Creates an inactive grab. The grab will become effective
 * after [method@Grab.activate].
 *
 * Returns: (transfer full): an opaque #ClutterGrab handle
 **/
ClutterGrab *
clutter_stage_grab_inactive (ClutterStage *stage,
                             ClutterActor *actor)
{
  return clutter_stage_grab_full (stage, actor, FALSE);
}

ClutterGrab *
clutter_stage_grab_input_only_inactive (ClutterStage         *stage,
                                        ClutterEventHandler   handler,
                                        gpointer              user_data,
                                        GDestroyNotify        user_data_destroy)
{
  ClutterInputOnlyActor *input_only_actor;
  ClutterActor *actor;

  input_only_actor = clutter_input_only_actor_new (handler, user_data,
                                                   user_data_destroy);
  actor = CLUTTER_ACTOR (input_only_actor);
  clutter_actor_set_name (actor, "input only grab actor");

  clutter_actor_insert_child_at_index (CLUTTER_ACTOR (stage), actor, 0);

  return clutter_stage_grab_full (stage, actor, TRUE);
}

void
clutter_stage_unlink_grab (ClutterStage *stage,
                           ClutterGrab  *grab)
{
  ClutterStagePrivate *priv = clutter_stage_get_instance_private (stage);
  ClutterGrab *prev, *next;
  gboolean was_grabbed;

  /* This grab is already detached */
  if (!grab->prev && !grab->next && priv->topmost_grab != grab)
    return;

  prev = grab->prev;
  next = grab->next;

  if (prev)
    prev->next = next;
  if (next)
    next->prev = prev;

  was_grabbed = !!priv->topmost_grab;

  if (priv->topmost_grab == grab)
    {
      /* This is the active grab */
      g_assert (prev == NULL);
      priv->topmost_grab = next;
      clutter_stage_notify_grab (stage, next, grab);
    }

  clutter_actor_detach_grab (grab->actor, grab);

  if (was_grabbed != !!priv->topmost_grab)
    g_object_notify_by_pspec (G_OBJECT (stage), obj_props[PROP_IS_GRABBED]);

  if (G_UNLIKELY (clutter_debug_flags & CLUTTER_DEBUG_GRABS))
    {
      unsigned int n_grabs = 0;
      ClutterGrab *g;

      for (g = priv->topmost_grab; g != NULL; g = g->next)
        n_grabs++;

      CLUTTER_NOTE (GRABS,
                    "[grab=%p] Detached seat grab (n_grabs: %u)",
                    grab, n_grabs);
    }

  grab->next = NULL;
  grab->prev = NULL;

  if (grab->owns_actor)
    g_clear_pointer (&grab->actor, clutter_actor_destroy);

  if (priv->topmost_grab)
    clutter_grab_notify (priv->topmost_grab);
}

/**
 * clutter_grab_dismiss:
 * @grab: Grab to undo
 *
 * Removes a grab. If this grab is effective, crossing events
 * will be generated to indicate the change in event redirection.
 **/
void
clutter_grab_dismiss (ClutterGrab *grab)
{
  g_return_if_fail (grab != NULL);

  clutter_stage_unlink_grab (grab->stage, grab);
}

/**
 * clutter_stage_get_grab_actor:
 * @stage: a #ClutterStage
 *
 * Gets the actor that currently holds a grab.
 *
 * Returns: (transfer none) (nullable): The grabbing actor
 **/
ClutterActor *
clutter_stage_get_grab_actor (ClutterStage *stage)
{
  ClutterStagePrivate *priv = clutter_stage_get_instance_private (stage);

  if (!priv->topmost_grab)
    return NULL;

  /* Return active grab */
  return priv->topmost_grab->actor;
}

/**
 * clutter_stage_get_event_actor:
 * @stage: a #ClutterStage
 * @event: an event received on the stage
 *
 * Retrieves the current focus actor for an event. This is
 * the key focus for key events and other events directed
 * to the key focus, or the actor directly under the
 * coordinates of a device or touch sequence.
 *
 * The actor is looked up at the time of calling this function,
 * and may differ from the actor that the stage originally
 * delivered the event to.
 *
 * Returns: (transfer none) (nullable): a pointer to the #ClutterActor or %NULL
 **/
ClutterActor *
clutter_stage_get_event_actor (ClutterStage       *stage,
                               const ClutterEvent *event)
{
  g_return_val_if_fail (CLUTTER_IS_STAGE (stage), NULL);
  g_return_val_if_fail (event != NULL, NULL);

  switch (clutter_event_type (event))
    {
    case CLUTTER_KEY_PRESS:
    case CLUTTER_KEY_RELEASE:
    case CLUTTER_KEY_STATE:
    case CLUTTER_PAD_BUTTON_PRESS:
    case CLUTTER_PAD_BUTTON_RELEASE:
    case CLUTTER_PAD_RING:
    case CLUTTER_PAD_STRIP:
    case CLUTTER_PAD_DIAL:
    case CLUTTER_IM_COMMIT:
    case CLUTTER_IM_DELETE:
    case CLUTTER_IM_PREEDIT:
      {
        ClutterContext *context =
          clutter_actor_get_context (CLUTTER_ACTOR (stage));
        ClutterBackend *backend = clutter_context_get_backend (context);
        ClutterFocus *focus =
          CLUTTER_FOCUS (clutter_backend_get_key_focus (backend, stage));
        ClutterActor *key_focus;

        key_focus = clutter_focus_get_current_actor (focus);

        return key_focus ? key_focus : CLUTTER_ACTOR (stage);
      }
    case CLUTTER_MOTION:
    case CLUTTER_ENTER:
    case CLUTTER_LEAVE:
    case CLUTTER_BUTTON_PRESS:
    case CLUTTER_BUTTON_RELEASE:
    case CLUTTER_SCROLL:
    case CLUTTER_TOUCH_BEGIN:
    case CLUTTER_TOUCH_UPDATE:
    case CLUTTER_TOUCH_END:
    case CLUTTER_TOUCH_CANCEL:
    case CLUTTER_TOUCHPAD_PINCH:
    case CLUTTER_TOUCHPAD_SWIPE:
    case CLUTTER_TOUCHPAD_HOLD:
    case CLUTTER_PROXIMITY_IN:
    case CLUTTER_PROXIMITY_OUT:
      {
        ClutterContext *context =
          clutter_actor_get_context (CLUTTER_ACTOR (stage));
        ClutterBackend *backend = clutter_context_get_backend (context);
        ClutterSprite *sprite;

        sprite = clutter_backend_get_sprite (backend, stage, event);

        return clutter_focus_get_current_actor (CLUTTER_FOCUS (sprite));
      }
    case CLUTTER_DEVICE_ADDED:
    case CLUTTER_DEVICE_REMOVED:
    case CLUTTER_NOTHING:
    case CLUTTER_EVENT_LAST:
      g_warn_if_reached ();
    }

  return NULL;
}

void
clutter_stage_maybe_lost_implicit_grab (ClutterStage  *self,
                                        ClutterSprite *sprite)
{
  clutter_sprite_maybe_lost_implicit_grab (sprite);
}

static gboolean
is_pointing_event (const ClutterEvent *event)
{
  switch (clutter_event_type (event))
    {
    case CLUTTER_KEY_PRESS:
    case CLUTTER_KEY_RELEASE:
    case CLUTTER_KEY_STATE:
    case CLUTTER_IM_COMMIT:
    case CLUTTER_IM_DELETE:
    case CLUTTER_IM_PREEDIT:
    case CLUTTER_PAD_BUTTON_PRESS:
    case CLUTTER_PAD_BUTTON_RELEASE:
    case CLUTTER_PAD_RING:
    case CLUTTER_PAD_STRIP:
    case CLUTTER_PAD_DIAL:
      return FALSE;
    case CLUTTER_MOTION:
    case CLUTTER_ENTER:
    case CLUTTER_LEAVE:
    case CLUTTER_BUTTON_PRESS:
    case CLUTTER_BUTTON_RELEASE:
    case CLUTTER_SCROLL:
    case CLUTTER_TOUCH_BEGIN:
    case CLUTTER_TOUCH_UPDATE:
    case CLUTTER_TOUCH_END:
    case CLUTTER_TOUCH_CANCEL:
    case CLUTTER_TOUCHPAD_PINCH:
    case CLUTTER_TOUCHPAD_SWIPE:
    case CLUTTER_TOUCHPAD_HOLD:
    case CLUTTER_PROXIMITY_IN:
    case CLUTTER_PROXIMITY_OUT:
      return TRUE;
    case CLUTTER_DEVICE_ADDED:
    case CLUTTER_DEVICE_REMOVED:
    case CLUTTER_NOTHING:
    case CLUTTER_EVENT_LAST:
      break;
    }

  g_warn_if_reached ();
  return FALSE;
}

void
clutter_stage_emit_event (ClutterStage       *self,
                          const ClutterEvent *event)
{
  ClutterContext *context =
    clutter_actor_get_context (CLUTTER_ACTOR (self));
  ClutterBackend *backend = clutter_context_get_backend (context);
  ClutterFocus *focus = NULL;

  COGL_TRACE_BEGIN_SCOPED (EmitEvent, "Clutter::Stage::emit_event()");

  if (is_pointing_event (event))
    focus = CLUTTER_FOCUS (clutter_backend_get_sprite (backend, self, event));
  else
    focus = CLUTTER_FOCUS (clutter_backend_get_key_focus (backend, self));

  clutter_focus_propagate_event (focus, event);

  if (clutter_event_type (event) == CLUTTER_PROXIMITY_OUT)
    {
      clutter_focus_set_current_actor (focus, NULL,
                                       clutter_event_get_source_device (event),
                                       clutter_event_get_time (event));
    }
}

static gboolean
break_implicit_grab_foreach_cb (ClutterStage  *self,
                                ClutterSprite *sprite,
                                gpointer       user_data)
{
  ClutterActor *actor = user_data;

  clutter_sprite_maybe_break_implicit_grab (sprite, actor);
  return TRUE;
}

void
clutter_stage_implicit_grab_actor_unmapped (ClutterStage *self,
                                            ClutterActor *actor)
{
  clutter_stage_foreach_sprite (self, break_implicit_grab_foreach_cb, actor);
}

void
clutter_stage_notify_action_implicit_grab (ClutterStage  *self,
                                           ClutterSprite *sprite)
{
  clutter_sprite_remove_all_actors_from_chain (sprite);
}

/**
 * clutter_stage_foreach_sprite:
 * @self: The stage
 * @func: (scope call): Iterator function
 * @user_data: user data
 *
 * Iterates over active input.
 *
 * Returns: %TRUE if the foreach function did not stop.
 **/
gboolean
clutter_stage_foreach_sprite (ClutterStage                 *self,
                              ClutterStageInputForeachFunc  func,
                              gpointer                      user_data)
{
  ClutterContext *context;
  ClutterBackend *backend;

  g_return_val_if_fail (CLUTTER_IS_STAGE (self), FALSE);
  g_return_val_if_fail (func != NULL, FALSE);

  context = clutter_actor_get_context (CLUTTER_ACTOR (self));
  backend = clutter_context_get_backend (context);

  return clutter_backend_foreach_sprite (backend, self, func, user_data);
}

GPtrArray *
clutter_stage_get_active_gestures_array (ClutterStage *self)
{
  ClutterStagePrivate *priv = clutter_stage_get_instance_private (self);

  return priv->all_active_gestures;
}

void
clutter_stage_update_device_for_event (ClutterStage *stage,
                                       ClutterEvent *event)
{
  ClutterEventType event_type = clutter_event_type (event);
  ClutterInputDevice *source_device = clutter_event_get_source_device (event);
  ClutterContext *context = clutter_actor_get_context (CLUTTER_ACTOR (stage));
  ClutterBackend *clutter_backend = clutter_context_get_backend (context);
  ClutterInputDeviceType device_type;
  ClutterSprite *sprite;
  graphene_point_t point;
  uint32_t time_ms;

  device_type = clutter_input_device_get_device_type (source_device);

  if (event_type == CLUTTER_TOUCH_END ||
      event_type == CLUTTER_TOUCH_CANCEL ||
      event_type == CLUTTER_DEVICE_REMOVED)
    {
      if (clutter_event_type (event) == CLUTTER_DEVICE_REMOVED)
        {
          if (device_type != CLUTTER_TABLET_DEVICE &&
              device_type != CLUTTER_PEN_DEVICE &&
              device_type != CLUTTER_ERASER_DEVICE &&
              device_type != CLUTTER_CURSOR_DEVICE)
            return;
        }

      clutter_event_get_coords (event, &point.x, &point.y);
      time_ms = clutter_event_get_time (event);

      sprite = clutter_backend_get_sprite (clutter_backend, stage, event);
      g_assert (sprite != NULL);
      clutter_sprite_update (sprite, point, NULL);
      clutter_focus_set_current_actor (CLUTTER_FOCUS (sprite), NULL,
                                       source_device, time_ms);
      clutter_backend_destroy_sprite (clutter_backend, sprite);
    }
  else if (event_type == CLUTTER_PROXIMITY_OUT)
    {
      sprite = clutter_backend_get_sprite (clutter_backend, stage, event);
      clutter_sprite_get_coords (sprite, &point);
      clutter_sprite_update (sprite, point, NULL);
    }
  else if (event_type != CLUTTER_PROXIMITY_IN)
    {
      g_assert (device_type != CLUTTER_KEYBOARD_DEVICE &&
                device_type != CLUTTER_PAD_DEVICE);

      clutter_event_get_coords (event, &point.x, &point.y);
      time_ms = clutter_event_get_time (event);

      sprite = clutter_backend_get_sprite (clutter_backend, stage, event);

      clutter_focus_update_from_event (CLUTTER_FOCUS (sprite), event);

      clutter_stage_pick_and_update_sprite (stage,
                                            sprite,
                                            source_device,
                                            CLUTTER_DEVICE_UPDATE_NONE,
                                            point,
                                            time_ms);
    }
}

static gboolean
update_devices_in_view_foreach_cb (ClutterStage  *stage,
                                   ClutterSprite *sprite,
                                   gpointer       user_data)
{
  ClutterStageView *pointer_view, *view = user_data;
  graphene_point_t coords;

  /* touchpoints are implicitly grabbed */
  if (clutter_sprite_get_role (sprite) == CLUTTER_SPRITE_ROLE_TOUCHPOINT)
    return TRUE;

  if (!clutter_focus_get_current_actor (CLUTTER_FOCUS (sprite)))
    return TRUE;

  clutter_sprite_get_coords (sprite, &coords);
  pointer_view = clutter_stage_get_view_at (stage,
                                            coords.x,
                                            coords.y);
  if (pointer_view && pointer_view == view)
    {
      clutter_stage_pick_and_update_sprite (stage,
                                            sprite,
                                            NULL,
                                            CLUTTER_DEVICE_UPDATE_IGNORE_CACHE,
                                            coords,
                                            CLUTTER_CURRENT_TIME);
    }

  return TRUE;
}

void
clutter_stage_update_devices_in_view (ClutterStage     *stage,
                                      ClutterStageView *view)
{
  clutter_stage_foreach_sprite (stage,
                                update_devices_in_view_foreach_cb,
                                view);
}
