typedef unsigned char   undefined;

typedef unsigned char    byte;
typedef unsigned char    dwfenc;
typedef unsigned int    dword;
typedef long double    longdouble;
typedef long long    longlong;
typedef unsigned long    qword;
typedef long    sqword;
typedef unsigned char    uchar;
typedef unsigned int    uint;
typedef unsigned long    ulong;
typedef unsigned long long    ulonglong;
typedef unsigned char    undefined1;
typedef unsigned int    undefined4;
typedef unsigned long    undefined8;
typedef unsigned short    ushort;
typedef unsigned short    word;
typedef struct eh_frame_hdr eh_frame_hdr, *Peh_frame_hdr;

struct eh_frame_hdr {
    byte eh_frame_hdr_version; // Exception Handler Frame Header Version
    dwfenc eh_frame_pointer_encoding; // Exception Handler Frame Pointer Encoding
    dwfenc eh_frame_desc_entry_count_encoding; // Encoding of # of Exception Handler FDEs
    dwfenc eh_frame_table_encoding; // Exception Handler Table Encoding
};

typedef struct NoteGnuPropertyElement_4 NoteGnuPropertyElement_4, *PNoteGnuPropertyElement_4;

struct NoteGnuPropertyElement_4 {
    dword prType;
    dword prDatasz;
    byte data[4];
};

typedef struct fde_table_entry fde_table_entry, *Pfde_table_entry;

struct fde_table_entry {
    dword initial_loc; // Initial Location
    dword data_loc; // Data location
};

typedef double gdouble;

typedef uint guint;

typedef dword guint32;

typedef float gfloat;

typedef char gchar;

typedef ulong gsize;

typedef ulong gulong;

typedef int gint;

typedef uchar __uint8_t;

typedef ulong guintptr;

typedef uchar guint8;

typedef sqword gint64;

typedef qword guint64;

typedef long glong;

typedef struct _GEnumValue _GEnumValue, *P_GEnumValue;

typedef struct _GEnumValue GEnumValue;

struct _GEnumValue {
    gint value;
    gchar *value_name;
    gchar *value_nick;
};

typedef struct _ClutterActorMetaClass _ClutterActorMetaClass, *P_ClutterActorMetaClass;

typedef struct _ClutterActorMeta _ClutterActorMeta, *P_ClutterActorMeta;

typedef struct _ClutterActorMeta ClutterActorMeta;

typedef struct _ClutterActor _ClutterActor, *P_ClutterActor;

typedef struct _ClutterActor ClutterActor;

typedef gint gboolean;

typedef struct _GObjectClass _GObjectClass, *P_GObjectClass;

typedef struct _GObject _GObject, *P_GObject;

typedef struct _GObject GObject;

typedef gsize GType;

typedef struct _GObjectConstructParam _GObjectConstructParam, *P_GObjectConstructParam;

typedef struct _GObjectConstructParam GObjectConstructParam;

typedef struct _GValue _GValue, *P_GValue;

typedef struct _GValue GValue;

typedef struct _GParamSpec _GParamSpec, *P_GParamSpec;

typedef struct _GParamSpec GParamSpec;

typedef struct _GObjectClass GInitiallyUnownedClass;

typedef struct _GObject GInitiallyUnowned;

typedef enum AtkRole {
    ATK_ROLE_INVALID=0,
    ATK_ROLE_ACCEL_LABEL=1,
    ATK_ROLE_ALERT=2,
    ATK_ROLE_ANIMATION=3,
    ATK_ROLE_ARROW=4,
    ATK_ROLE_CALENDAR=5,
    ATK_ROLE_CANVAS=6,
    ATK_ROLE_CHECK_BOX=7,
    ATK_ROLE_CHECK_MENU_ITEM=8,
    ATK_ROLE_COLOR_CHOOSER=9,
    ATK_ROLE_COLUMN_HEADER=10,
    ATK_ROLE_COMBO_BOX=11,
    ATK_ROLE_DATE_EDITOR=12,
    ATK_ROLE_DESKTOP_ICON=13,
    ATK_ROLE_DESKTOP_FRAME=14,
    ATK_ROLE_DIAL=15,
    ATK_ROLE_DIALOG=16,
    ATK_ROLE_DIRECTORY_PANE=17,
    ATK_ROLE_DRAWING_AREA=18,
    ATK_ROLE_FILE_CHOOSER=19,
    ATK_ROLE_FILLER=20,
    ATK_ROLE_FONT_CHOOSER=21,
    ATK_ROLE_FRAME=22,
    ATK_ROLE_GLASS_PANE=23,
    ATK_ROLE_HTML_CONTAINER=24,
    ATK_ROLE_ICON=25,
    ATK_ROLE_IMAGE=26,
    ATK_ROLE_INTERNAL_FRAME=27,
    ATK_ROLE_LABEL=28,
    ATK_ROLE_LAYERED_PANE=29,
    ATK_ROLE_LIST=30,
    ATK_ROLE_LIST_ITEM=31,
    ATK_ROLE_MENU=32,
    ATK_ROLE_MENU_BAR=33,
    ATK_ROLE_MENU_ITEM=34,
    ATK_ROLE_OPTION_PANE=35,
    ATK_ROLE_PAGE_TAB=36,
    ATK_ROLE_PAGE_TAB_LIST=37,
    ATK_ROLE_PANEL=38,
    ATK_ROLE_PASSWORD_TEXT=39,
    ATK_ROLE_POPUP_MENU=40,
    ATK_ROLE_PROGRESS_BAR=41,
    ATK_ROLE_BUTTON=42,
    ATK_ROLE_PUSH_BUTTON=42,
    ATK_ROLE_RADIO_BUTTON=43,
    ATK_ROLE_RADIO_MENU_ITEM=44,
    ATK_ROLE_ROOT_PANE=45,
    ATK_ROLE_ROW_HEADER=46,
    ATK_ROLE_SCROLL_BAR=47,
    ATK_ROLE_SCROLL_PANE=48,
    ATK_ROLE_SEPARATOR=49,
    ATK_ROLE_SLIDER=50,
    ATK_ROLE_SPLIT_PANE=51,
    ATK_ROLE_SPIN_BUTTON=52,
    ATK_ROLE_STATUSBAR=53,
    ATK_ROLE_TABLE=54,
    ATK_ROLE_TABLE_CELL=55,
    ATK_ROLE_TABLE_COLUMN_HEADER=56,
    ATK_ROLE_TABLE_ROW_HEADER=57,
    ATK_ROLE_TEAR_OFF_MENU_ITEM=58,
    ATK_ROLE_TERMINAL=59,
    ATK_ROLE_TEXT=60,
    ATK_ROLE_TOGGLE_BUTTON=61,
    ATK_ROLE_TOOL_BAR=62,
    ATK_ROLE_TOOL_TIP=63,
    ATK_ROLE_TREE=64,
    ATK_ROLE_TREE_TABLE=65,
    ATK_ROLE_UNKNOWN=66,
    ATK_ROLE_VIEWPORT=67,
    ATK_ROLE_WINDOW=68,
    ATK_ROLE_HEADER=69,
    ATK_ROLE_FOOTER=70,
    ATK_ROLE_PARAGRAPH=71,
    ATK_ROLE_RULER=72,
    ATK_ROLE_APPLICATION=73,
    ATK_ROLE_AUTOCOMPLETE=74,
    ATK_ROLE_EDITBAR=75,
    ATK_ROLE_EMBEDDED=76,
    ATK_ROLE_ENTRY=77,
    ATK_ROLE_CHART=78,
    ATK_ROLE_CAPTION=79,
    ATK_ROLE_DOCUMENT_FRAME=80,
    ATK_ROLE_HEADING=81,
    ATK_ROLE_PAGE=82,
    ATK_ROLE_SECTION=83,
    ATK_ROLE_REDUNDANT_OBJECT=84,
    ATK_ROLE_FORM=85,
    ATK_ROLE_LINK=86,
    ATK_ROLE_INPUT_METHOD_WINDOW=87,
    ATK_ROLE_TABLE_ROW=88,
    ATK_ROLE_TREE_ITEM=89,
    ATK_ROLE_DOCUMENT_SPREADSHEET=90,
    ATK_ROLE_DOCUMENT_PRESENTATION=91,
    ATK_ROLE_DOCUMENT_TEXT=92,
    ATK_ROLE_DOCUMENT_WEB=93,
    ATK_ROLE_DOCUMENT_EMAIL=94,
    ATK_ROLE_COMMENT=95,
    ATK_ROLE_LIST_BOX=96,
    ATK_ROLE_GROUPING=97,
    ATK_ROLE_IMAGE_MAP=98,
    ATK_ROLE_NOTIFICATION=99,
    ATK_ROLE_INFO_BAR=100,
    ATK_ROLE_LEVEL_BAR=101,
    ATK_ROLE_TITLE_BAR=102,
    ATK_ROLE_BLOCK_QUOTE=103,
    ATK_ROLE_AUDIO=104,
    ATK_ROLE_VIDEO=105,
    ATK_ROLE_DEFINITION=106,
    ATK_ROLE_ARTICLE=107,
    ATK_ROLE_LANDMARK=108,
    ATK_ROLE_LOG=109,
    ATK_ROLE_MARQUEE=110,
    ATK_ROLE_MATH=111,
    ATK_ROLE_RATING=112,
    ATK_ROLE_TIMER=113,
    ATK_ROLE_DESCRIPTION_LIST=114,
    ATK_ROLE_DESCRIPTION_TERM=115,
    ATK_ROLE_DESCRIPTION_VALUE=116,
    ATK_ROLE_STATIC=117,
    ATK_ROLE_MATH_FRACTION=118,
    ATK_ROLE_MATH_ROOT=119,
    ATK_ROLE_SUBSCRIPT=120,
    ATK_ROLE_SUPERSCRIPT=121,
    ATK_ROLE_FOOTNOTE=122,
    ATK_ROLE_CONTENT_DELETION=123,
    ATK_ROLE_CONTENT_INSERTION=124,
    ATK_ROLE_MARK=125,
    ATK_ROLE_SUGGESTION=126,
    ATK_ROLE_PUSH_BUTTON_MENU=127,
    ATK_ROLE_SWITCH=128,
    ATK_ROLE_LAST_DEFINED=129
} AtkRole;

typedef struct _ClutterActorPrivate _ClutterActorPrivate, *P_ClutterActorPrivate;

typedef struct _ClutterActorPrivate ClutterActorPrivate;

typedef struct _GTypeClass _GTypeClass, *P_GTypeClass;

typedef struct _GTypeClass GTypeClass;

typedef struct _GSList _GSList, *P_GSList;

typedef struct _GSList GSList;

typedef struct _GTypeInstance _GTypeInstance, *P_GTypeInstance;

typedef struct _GTypeInstance GTypeInstance;

typedef struct _GData _GData, *P_GData;

typedef struct _GData GData;

typedef union anon_union_8_9_cc3fcca0 anon_union_8_9_cc3fcca0, *Panon_union_8_9_cc3fcca0;

typedef enum GParamFlags {
    G_PARAM_DEPRECATED=-2147483648,
    G_PARAM_READABLE=1,
    G_PARAM_WRITABLE=2,
    G_PARAM_READWRITE=3,
    G_PARAM_CONSTRUCT=4,
    G_PARAM_CONSTRUCT_ONLY=8,
    G_PARAM_LAX_VALIDATION=16,
    G_PARAM_PRIVATE=32,
    G_PARAM_STATIC_NAME=32,
    G_PARAM_STATIC_NICK=64,
    G_PARAM_STATIC_BLURB=128,
    G_PARAM_EXPLICIT_NOTIFY=1073741824
} GParamFlags;

typedef void *gpointer;

struct _GObjectConstructParam {
    GParamSpec *pspec;
    GValue *value;
};

struct _GTypeClass {
    GType g_type;
};

struct _GSList {
    gpointer data;
    GSList *next;
};

struct _GTypeInstance {
    GTypeClass *g_class;
};

struct _GParamSpec {
    GTypeInstance g_type_instance;
    gchar *name;
    enum GParamFlags flags;
    GType value_type;
    GType owner_type;
    gchar *_nick;
    gchar *_blurb;
    GData *qdata;
    guint ref_count;
    guint param_id;
};

struct _GObject {
    GTypeInstance g_type_instance;
    guint ref_count;
    GData *qdata;
};

union anon_union_8_9_cc3fcca0 {
    gint v_int;
    guint v_uint;
    glong v_long;
    gulong v_ulong;
    gint64 v_int64;
    guint64 v_uint64;
    gfloat v_float;
    gdouble v_double;
    gpointer v_pointer;
};

struct _GValue {
    GType g_type;
    union anon_union_8_9_cc3fcca0 data[2];
};

struct _ClutterActorMeta {
    GInitiallyUnowned parent_instance;
};

struct _ClutterActor {
    GInitiallyUnowned parent_instance;
    guint32 flags;
    enum AtkRole accessible_role;
    guint32 private_flags;
    ClutterActorPrivate *priv;
};

struct _GObjectClass {
    GTypeClass g_type_class;
    GSList *construct_properties;
    GObject * (*constructor)(GType, guint, GObjectConstructParam *);
    void (*set_property)(GObject *, guint, GValue *, GParamSpec *);
    void (*get_property)(GObject *, guint, GValue *, GParamSpec *);
    void (*dispose)(GObject *);
    void (*finalize)(GObject *);
    void (*dispatch_properties_changed)(GObject *, guint, GParamSpec **);
    void (*notify)(GObject *, GParamSpec *);
    void (*constructed)(GObject *);
    gsize flags;
    gsize n_construct_properties;
    gpointer pspecs;
    gsize n_pspecs;
    gpointer pdummy[3];
};

struct _GData {
};

struct _ClutterActorPrivate {
};

struct _ClutterActorMetaClass {
    GInitiallyUnownedClass parent_class;
    void (*set_actor)(ClutterActorMeta *, ClutterActor *);
    void (*set_enabled)(ClutterActorMeta *, gboolean);
};

typedef struct _ClutterActorMetaClass ClutterActorMetaClass;

typedef enum CoglSnippetHook {
    COGL_SNIPPET_HOOK_VERTEX=0,
    COGL_SNIPPET_HOOK_VERTEX_TRANSFORM=1,
    COGL_SNIPPET_HOOK_VERTEX_GLOBALS=2,
    COGL_SNIPPET_HOOK_POINT_SIZE=3,
    COGL_SNIPPET_HOOK_FRAGMENT=2048,
    COGL_SNIPPET_HOOK_FRAGMENT_GLOBALS=2049,
    COGL_SNIPPET_HOOK_TEXTURE_COORD_TRANSFORM=4096,
    COGL_SNIPPET_HOOK_LAYER_FRAGMENT=6144,
    COGL_SNIPPET_HOOK_TEXTURE_LOOKUP=6145
} CoglSnippetHook;

typedef struct _graphene_point3d_t _graphene_point3d_t, *P_graphene_point3d_t;

typedef struct _graphene_point3d_t graphene_point3d_t;

struct _graphene_point3d_t {
    float x;
    float y;
    float z;
};

typedef struct _graphene_matrix_t _graphene_matrix_t, *P_graphene_matrix_t;

typedef struct _graphene_matrix_t graphene_matrix_t;

typedef struct graphene_simd4x4f_t graphene_simd4x4f_t, *Pgraphene_simd4x4f_t;

typedef float __m128[4];

typedef __m128 graphene_simd4f_t;

struct graphene_simd4x4f_t {
    graphene_simd4f_t x;
    graphene_simd4f_t y;
    graphene_simd4f_t z;
    graphene_simd4f_t w;
};

struct _graphene_matrix_t {
    struct graphene_simd4x4f_t __graphene_private_value;
};

typedef struct _ClutterPaintNode _ClutterPaintNode, *P_ClutterPaintNode;

typedef struct _ClutterPaintNode ClutterPaintNode;

typedef ClutterPaintNode *ClutterPaintNode_autoptr;

struct _ClutterPaintNode {
};

typedef struct _ClutterBackend _ClutterBackend, *P_ClutterBackend;

typedef struct _ClutterBackend ClutterBackend;

struct _ClutterBackend {
};

typedef struct _MtkRectangle _MtkRectangle, *P_MtkRectangle;

typedef struct _MtkRectangle MtkRectangle;

struct _MtkRectangle {
    int x;
    int y;
    int width;
    int height;
};

typedef struct _GObjectClass GObjectClass;

typedef enum GLogLevelFlags {
    G_LOG_LEVEL_MASK=-4,
    G_LOG_FLAG_RECURSION=1,
    G_LOG_FLAG_FATAL=2,
    G_LOG_LEVEL_ERROR=4,
    G_LOG_LEVEL_CRITICAL=8,
    G_LOG_LEVEL_WARNING=16,
    G_LOG_LEVEL_MESSAGE=32,
    G_LOG_LEVEL_INFO=64,
    G_LOG_LEVEL_DEBUG=128
} GLogLevelFlags;

typedef struct _CoglColor _CoglColor, *P_CoglColor;

typedef __uint8_t uint8_t;

struct _CoglColor {
    uint8_t red;
    uint8_t green;
    uint8_t blue;
    uint8_t alpha;
};

typedef struct _CoglTexture _CoglTexture, *P_CoglTexture;

struct _CoglTexture {
    GObject parent_instance;
};

typedef struct GbLiquidGlassEffectClass GbLiquidGlassEffectClass, *PGbLiquidGlassEffectClass;

typedef struct _ClutterEffectClass _ClutterEffectClass, *P_ClutterEffectClass;

typedef struct _ClutterEffect _ClutterEffect, *P_ClutterEffect;

typedef struct _ClutterEffect ClutterEffect;

typedef struct _ClutterPaintContext _ClutterPaintContext, *P_ClutterPaintContext;

typedef struct _ClutterPaintContext ClutterPaintContext;

typedef struct _ClutterPaintVolume _ClutterPaintVolume, *P_ClutterPaintVolume;

typedef struct _ClutterPaintVolume ClutterPaintVolume;

typedef enum ClutterEffectPaintFlags {
    CLUTTER_EFFECT_PAINT_ACTOR_DIRTY=1,
    CLUTTER_EFFECT_PAINT_BYPASS_EFFECT=2
} ClutterEffectPaintFlags;

typedef struct _ClutterPickContext _ClutterPickContext, *P_ClutterPickContext;

typedef struct _ClutterPickContext ClutterPickContext;

typedef struct _ClutterEffectClass ClutterEffectClass;

struct _ClutterPickContext {
};

struct _ClutterPaintVolume {
};

struct _ClutterEffect {
    ClutterActorMeta parent_instance;
};

struct _ClutterEffectClass {
    ClutterActorMetaClass parent_class;
    gboolean (*pre_paint)(ClutterEffect *, ClutterPaintNode *, ClutterPaintContext *);
    void (*post_paint)(ClutterEffect *, ClutterPaintNode *, ClutterPaintContext *);
    gboolean (*modify_paint_volume)(ClutterEffect *, ClutterPaintVolume *);
    void (*paint)(ClutterEffect *, ClutterPaintNode *, ClutterPaintContext *, enum ClutterEffectPaintFlags);
    void (*paint_node)(ClutterEffect *, ClutterPaintNode *, ClutterPaintContext *, enum ClutterEffectPaintFlags);
    void (*pick)(ClutterEffect *, ClutterPickContext *);
};

struct GbLiquidGlassEffectClass {
    ClutterEffectClass parent_class;
};

struct _ClutterPaintContext {
};

typedef struct _GbLiquidGlassEffect _GbLiquidGlassEffect, *P_GbLiquidGlassEffect;

typedef struct _GbLiquidGlassEffect GbLiquidGlassEffect;

typedef struct FramebufferData FramebufferData, *PFramebufferData;

typedef enum CacheFlags {
    ACTOR_PAINTED=1,
    BLUR_APPLIED=2
} CacheFlags;

typedef enum GbBlurMode {
    GB_BLUR_MODE_ACTOR=0,
    GB_BLUR_MODE_BACKGROUND=1
} GbBlurMode;

typedef struct _CoglFramebuffer _CoglFramebuffer, *P_CoglFramebuffer;

typedef struct _CoglFramebuffer CoglFramebuffer;

typedef struct _CoglPipeline _CoglPipeline, *P_CoglPipeline;

typedef struct _CoglPipeline CoglPipeline;

typedef struct _CoglTexture CoglTexture;

struct _CoglFramebuffer {
    GObject parent_instance;
};

struct FramebufferData {
    CoglFramebuffer *framebuffer;
    CoglPipeline *pipeline;
    CoglTexture *texture;
};

struct _GbLiquidGlassEffect {
    ClutterEffect parent_instance;
    ClutterActor *actor;
    float tex_width;
    float tex_height;
    struct FramebufferData actor_fb;
    enum CacheFlags cache_flags;
    struct FramebufferData background_fb;
    struct FramebufferData brightness_fb;
    int brightness_uniform;
    struct FramebufferData mask_fb;
    int corner_radius_uniform;
    int mask_size_uniform;
    int highlight_uniform;
    int refraction_uniform;
    int depth_uniform;
    enum GbBlurMode mode;
    float downscale_factor;
    float brightness;
    int radius;
    float corner_radius;
    float highlight;
    float refraction;
    float depth;
};

struct _CoglPipeline {
};

typedef enum anon_enum_32.conflict {
    PROP_0=0,
    PROP_RADIUS=1,
    PROP_BRIGHTNESS=2,
    PROP_MODE=3,
    PROP_CORNER_RADIUS=4,
    PROP_HIGHLIGHT=5,
    PROP_REFRACTION=6,
    PROP_DEPTH=7,
    N_PROPS=8
} anon_enum_32.conflict;

typedef enum CoglPipelineFilter {
    COGL_PIPELINE_FILTER_NEAREST=9728,
    COGL_PIPELINE_FILTER_LINEAR=9729,
    COGL_PIPELINE_FILTER_NEAREST_MIPMAP_NEAREST=9984,
    COGL_PIPELINE_FILTER_LINEAR_MIPMAP_NEAREST=9985,
    COGL_PIPELINE_FILTER_NEAREST_MIPMAP_LINEAR=9986,
    COGL_PIPELINE_FILTER_LINEAR_MIPMAP_LINEAR=9987
} CoglPipelineFilter;

typedef enum CoglPipelineWrapMode {
    COGL_PIPELINE_WRAP_MODE_AUTOMATIC=519,
    COGL_PIPELINE_WRAP_MODE_REPEAT=10497,
    COGL_PIPELINE_WRAP_MODE_CLAMP_TO_EDGE=33071,
    COGL_PIPELINE_WRAP_MODE_MIRRORED_REPEAT=33648
} CoglPipelineWrapMode;

typedef struct _CoglOffscreen _CoglOffscreen, *P_CoglOffscreen;

struct _CoglOffscreen {
};

typedef struct _ClutterBlitNode _ClutterBlitNode, *P_ClutterBlitNode;

struct _ClutterBlitNode {
};

typedef struct _CoglSnippet _CoglSnippet, *P_CoglSnippet;

struct _CoglSnippet {
};

typedef struct _CoglContext _CoglContext, *P_CoglContext;

struct _CoglContext {
};

typedef struct _ClutterActorBox _ClutterActorBox, *P_ClutterActorBox;

typedef struct _ClutterActorBox ClutterActorBox;

struct _ClutterActorBox {
    gfloat x1;
    gfloat y1;
    gfloat x2;
    gfloat y2;
};

typedef struct _GbBlurEffect _GbBlurEffect, *P_GbBlurEffect;

struct _GbBlurEffect {
    ClutterEffect parent_instance;
    ClutterActor *actor;
    float tex_width;
    float tex_height;
    struct FramebufferData actor_fb;
    enum CacheFlags cache_flags;
    struct FramebufferData background_fb;
    struct FramebufferData brightness_fb;
    int brightness_uniform;
    struct FramebufferData mask_fb;
    int corner_radius_uniform;
    int mask_size_uniform;
    enum GbBlurMode mode;
    float downscale_factor;
    float brightness;
    int radius;
    float corner_radius;
};

typedef struct _CoglOffscreen CoglOffscreen;

typedef enum GTypeFlags {
    G_TYPE_FLAG_NONE=0,
    G_TYPE_FLAG_ABSTRACT=16,
    G_TYPE_FLAG_VALUE_ABSTRACT=32,
    G_TYPE_FLAG_FINAL=64,
    G_TYPE_FLAG_DEPRECATED=128
} GTypeFlags;

typedef void (*GClassInitFunc)(gpointer, gpointer);

typedef void (*GInstanceInitFunc)(GTypeInstance *, gpointer);

typedef enum anon_enum_32 {
    CLUTTER_INPUT_AXIS_IGNORE=0,
    GB_BLUR_MODE_ACTOR=0,
    G_IO_ERROR_FAILED=0,
    PROP_0=0,
    CLUTTER_INPUT_AXIS_X=1,
    GB_BLUR_MODE_BACKGROUND=1,
    G_IO_ERROR_NOT_FOUND=1,
    PROP_RADIUS=1,
    CLUTTER_INPUT_AXIS_Y=2,
    G_IO_ERROR_EXISTS=2,
    PROP_BRIGHTNESS=2,
    CLUTTER_INPUT_AXIS_PRESSURE=3,
    G_IO_ERROR_IS_DIRECTORY=3,
    PROP_MODE=3,
    CLUTTER_INPUT_AXIS_XTILT=4,
    G_IO_ERROR_NOT_DIRECTORY=4,
    PROP_CORNER_RADIUS=4,
    CLUTTER_INPUT_AXIS_YTILT=5,
    G_IO_ERROR_NOT_EMPTY=5,
    N_PROPS=5,
    CLUTTER_INPUT_AXIS_WHEEL=6,
    G_IO_ERROR_NOT_REGULAR_FILE=6,
    CLUTTER_INPUT_AXIS_DISTANCE=7,
    G_IO_ERROR_NOT_SYMBOLIC_LINK=7,
    CLUTTER_INPUT_AXIS_ROTATION=8,
    G_IO_ERROR_NOT_MOUNTABLE_FILE=8,
    CLUTTER_INPUT_AXIS_SLIDER=9,
    G_IO_ERROR_FILENAME_TOO_LONG=9,
    CLUTTER_INPUT_AXIS_LAST=10,
    G_IO_ERROR_INVALID_FILENAME=10,
    G_IO_ERROR_TOO_MANY_LINKS=11,
    G_IO_ERROR_NO_SPACE=12,
    G_IO_ERROR_INVALID_ARGUMENT=13,
    G_IO_ERROR_PERMISSION_DENIED=14,
    G_IO_ERROR_NOT_SUPPORTED=15,
    G_IO_ERROR_NOT_MOUNTED=16,
    G_IO_ERROR_ALREADY_MOUNTED=17,
    G_IO_ERROR_CLOSED=18,
    G_IO_ERROR_CANCELLED=19,
    G_IO_ERROR_PENDING=20,
    G_IO_ERROR_READ_ONLY=21,
    G_IO_ERROR_CANT_CREATE_BACKUP=22,
    G_IO_ERROR_WRONG_ETAG=23,
    G_IO_ERROR_TIMED_OUT=24,
    G_IO_ERROR_WOULD_RECURSE=25,
    G_IO_ERROR_BUSY=26,
    G_IO_ERROR_WOULD_BLOCK=27,
    G_IO_ERROR_HOST_NOT_FOUND=28,
    G_IO_ERROR_WOULD_MERGE=29,
    G_IO_ERROR_FAILED_HANDLED=30,
    G_IO_ERROR_TOO_MANY_OPEN_FILES=31,
    G_IO_ERROR_NOT_INITIALIZED=32,
    G_IO_ERROR_ADDRESS_IN_USE=33,
    G_IO_ERROR_PARTIAL_INPUT=34,
    G_IO_ERROR_INVALID_DATA=35,
    G_IO_ERROR_DBUS_ERROR=36,
    G_IO_ERROR_HOST_UNREACHABLE=37,
    G_IO_ERROR_NETWORK_UNREACHABLE=38,
    G_IO_ERROR_CONNECTION_REFUSED=39,
    G_IO_ERROR_PROXY_FAILED=40,
    G_IO_ERROR_PROXY_AUTH_FAILED=41,
    G_IO_ERROR_PROXY_NEED_AUTH=42,
    G_IO_ERROR_PROXY_NOT_ALLOWED=43,
    G_IO_ERROR_BROKEN_PIPE=44,
    G_IO_ERROR_CONNECTION_CLOSED=44,
    G_IO_ERROR_NOT_CONNECTED=45,
    G_IO_ERROR_MESSAGE_TOO_LARGE=46,
    G_IO_ERROR_NO_SUCH_DEVICE=47,
    G_IO_ERROR_DESTINATION_UNSET=48
} anon_enum_32;

typedef struct _ClutterBlitNode ClutterBlitNode;

typedef struct _CoglContext CoglContext;

typedef struct _CoglColor CoglColor;

typedef struct _CoglSnippet CoglSnippet;

typedef struct GbBlurEffectClass GbBlurEffectClass, *PGbBlurEffectClass;

struct GbBlurEffectClass {
    ClutterEffectClass parent_class;
};

typedef struct _GbBlurEffect GbBlurEffect;

typedef struct _ClutterStageView _ClutterStageView, *P_ClutterStageView;

typedef struct _ClutterStageView ClutterStageView;

struct _ClutterStageView {
    GObject parent_instance;
};

typedef struct Elf64_Shdr Elf64_Shdr, *PElf64_Shdr;

typedef enum Elf_SectionHeaderType {
    SHT_NULL=0,
    SHT_PROGBITS=1,
    SHT_SYMTAB=2,
    SHT_STRTAB=3,
    SHT_RELA=4,
    SHT_HASH=5,
    SHT_DYNAMIC=6,
    SHT_NOTE=7,
    SHT_NOBITS=8,
    SHT_REL=9,
    SHT_SHLIB=10,
    SHT_DYNSYM=11,
    SHT_INIT_ARRAY=14,
    SHT_FINI_ARRAY=15,
    SHT_PREINIT_ARRAY=16,
    SHT_GROUP=17,
    SHT_SYMTAB_SHNDX=18,
    SHT_ANDROID_REL=1610612737,
    SHT_ANDROID_RELA=1610612738,
    SHT_GNU_ATTRIBUTES=1879048181,
    SHT_GNU_HASH=1879048182,
    SHT_GNU_LIBLIST=1879048183,
    SHT_CHECKSUM=1879048184,
    SHT_SUNW_move=1879048186,
    SHT_SUNW_COMDAT=1879048187,
    SHT_SUNW_syminfo=1879048188,
    SHT_GNU_verdef=1879048189,
    SHT_GNU_verneed=1879048190,
    SHT_GNU_versym=1879048191
} Elf_SectionHeaderType;

struct Elf64_Shdr {
    dword sh_name;
    enum Elf_SectionHeaderType sh_type;
    qword sh_flags;
    qword sh_addr;
    qword sh_offset;
    qword sh_size;
    dword sh_link;
    dword sh_info;
    qword sh_addralign;
    qword sh_entsize;
};

typedef enum Elf_ProgramHeaderType {
    PT_NULL=0,
    PT_LOAD=1,
    PT_DYNAMIC=2,
    PT_INTERP=3,
    PT_NOTE=4,
    PT_SHLIB=5,
    PT_PHDR=6,
    PT_TLS=7,
    PT_GNU_EH_FRAME=1685382480,
    PT_GNU_STACK=1685382481,
    PT_GNU_RELRO=1685382482
} Elf_ProgramHeaderType;

typedef struct Elf64_Dyn Elf64_Dyn, *PElf64_Dyn;

typedef enum Elf64_DynTag {
    DT_NULL=0,
    DT_NEEDED=1,
    DT_PLTRELSZ=2,
    DT_PLTGOT=3,
    DT_HASH=4,
    DT_STRTAB=5,
    DT_SYMTAB=6,
    DT_RELA=7,
    DT_RELASZ=8,
    DT_RELAENT=9,
    DT_STRSZ=10,
    DT_SYMENT=11,
    DT_INIT=12,
    DT_FINI=13,
    DT_SONAME=14,
    DT_RPATH=15,
    DT_SYMBOLIC=16,
    DT_REL=17,
    DT_RELSZ=18,
    DT_RELENT=19,
    DT_PLTREL=20,
    DT_DEBUG=21,
    DT_TEXTREL=22,
    DT_JMPREL=23,
    DT_BIND_NOW=24,
    DT_INIT_ARRAY=25,
    DT_FINI_ARRAY=26,
    DT_INIT_ARRAYSZ=27,
    DT_FINI_ARRAYSZ=28,
    DT_RUNPATH=29,
    DT_FLAGS=30,
    DT_PREINIT_ARRAY=32,
    DT_PREINIT_ARRAYSZ=33,
    DT_RELRSZ=35,
    DT_RELR=36,
    DT_RELRENT=37,
    DT_ANDROID_REL=1610612751,
    DT_ANDROID_RELSZ=1610612752,
    DT_ANDROID_RELA=1610612753,
    DT_ANDROID_RELASZ=1610612754,
    DT_ANDROID_RELR=1879040000,
    DT_ANDROID_RELRSZ=1879040001,
    DT_ANDROID_RELRENT=1879040003,
    DT_GNU_PRELINKED=1879047669,
    DT_GNU_CONFLICTSZ=1879047670,
    DT_GNU_LIBLISTSZ=1879047671,
    DT_CHECKSUM=1879047672,
    DT_PLTPADSZ=1879047673,
    DT_MOVEENT=1879047674,
    DT_MOVESZ=1879047675,
    DT_FEATURE_1=1879047676,
    DT_POSFLAG_1=1879047677,
    DT_SYMINSZ=1879047678,
    DT_SYMINENT=1879047679,
    DT_GNU_XHASH=1879047924,
    DT_GNU_HASH=1879047925,
    DT_TLSDESC_PLT=1879047926,
    DT_TLSDESC_GOT=1879047927,
    DT_GNU_CONFLICT=1879047928,
    DT_GNU_LIBLIST=1879047929,
    DT_CONFIG=1879047930,
    DT_DEPAUDIT=1879047931,
    DT_AUDIT=1879047932,
    DT_PLTPAD=1879047933,
    DT_MOVETAB=1879047934,
    DT_SYMINFO=1879047935,
    DT_VERSYM=1879048176,
    DT_RELACOUNT=1879048185,
    DT_RELCOUNT=1879048186,
    DT_FLAGS_1=1879048187,
    DT_VERDEF=1879048188,
    DT_VERDEFNUM=1879048189,
    DT_VERNEED=1879048190,
    DT_VERNEEDNUM=1879048191,
    DT_AUXILIARY=2147483645,
    DT_FILTER=2147483647
} Elf64_DynTag;

struct Elf64_Dyn {
    enum Elf64_DynTag d_tag;
    qword d_val;
};

typedef struct Elf64_Rela Elf64_Rela, *PElf64_Rela;

struct Elf64_Rela {
    qword r_offset; // location to apply the relocation action
    qword r_info; // the symbol table index and the type of relocation
    qword r_addend; // a constant addend used to compute the relocatable field value
};

typedef struct GnuBuildId GnuBuildId, *PGnuBuildId;

struct GnuBuildId {
    dword namesz; // Length of name field
    dword descsz; // Length of description field
    dword type; // Vendor specific type
    char name[4]; // Vendor name
    byte hash[20];
};

typedef struct Elf64_Sym Elf64_Sym, *PElf64_Sym;

struct Elf64_Sym {
    dword st_name;
    byte st_info;
    byte st_other;
    word st_shndx;
    qword st_value;
    qword st_size;
};

typedef struct NoteGnuProperty_4 NoteGnuProperty_4, *PNoteGnuProperty_4;

struct NoteGnuProperty_4 {
    dword namesz; // Length of name field
    dword descsz; // Length of description field
    dword type; // Vendor specific type
    char name[4]; // Vendor name
};

typedef struct Elf64_Ehdr Elf64_Ehdr, *PElf64_Ehdr;

struct Elf64_Ehdr {
    byte e_ident_magic_num;
    char e_ident_magic_str[3];
    byte e_ident_class;
    byte e_ident_data;
    byte e_ident_version;
    byte e_ident_osabi;
    byte e_ident_abiversion;
    byte e_ident_pad[7];
    word e_type;
    word e_machine;
    dword e_version;
    qword e_entry;
    qword e_phoff;
    qword e_shoff;
    dword e_flags;
    word e_ehsize;
    word e_phentsize;
    word e_phnum;
    word e_shentsize;
    word e_shnum;
    word e_shstrndx;
};

typedef struct Elf64_Phdr Elf64_Phdr, *PElf64_Phdr;

struct Elf64_Phdr {
    enum Elf_ProgramHeaderType p_type;
    dword p_flags;
    qword p_offset;
    qword p_vaddr;
    qword p_paddr;
    qword p_filesz;
    qword p_memsz;
    qword p_align;
};

typedef struct evp_pkey_ctx_st evp_pkey_ctx_st, *Pevp_pkey_ctx_st;

struct evp_pkey_ctx_st {
};

typedef struct evp_pkey_ctx_st EVP_PKEY_CTX;



GParamSpec *[5] properties;
GParamSpec *[8] properties;
GType static_g_define_type_id;
GType etype;
GEnumValue[3] values;
undefined1 completed.0;
pointer __dso_handle;
gpointer gb_blur_effect_parent_class;
gint GbBlurEffect_private_offset;
undefined gb_blur_effect_init;
undefined gb_blur_effect_class_intern_init;
CoglPipeline *base_pipeline;
CoglPipeline *brightness_pipeline;
gchar *brightness_glsl_declarations;
gchar *brightness_glsl;
CoglPipeline *mask_pipeline;
gchar *mask_glsl_declarations;
gchar *mask_glsl;
undefined gb_blur_effect_get_property;
undefined gb_blur_effect_set_property;
undefined DAT_0010a500;
undefined gb_blur_effect_set_actor;
undefined gb_blur_effect_paint_node;
undefined gb_blur_effect_finalize;
gpointer gb_liquid_glass_effect_parent_class;
gint GbLiquidGlassEffect_private_offset;
undefined gb_liquid_glass_effect_class_intern_init;
undefined gb_liquid_glass_effect_init;
gchar *size_glsl_declarations;
gchar *glass_lookup_glsl_declarations;
gchar *glass_lookup_glsl;
gchar *glass_glsl_declarations;
gchar *glass_glsl;
undefined gb_liquid_glass_effect_set_actor;
undefined gb_liquid_glass_effect_paint_node;
undefined DAT_0010b938;
undefined gb_liquid_glass_effect_finalize;
undefined gb_liquid_glass_effect_get_property;
undefined gb_liquid_glass_effect_set_property;

int _init(EVP_PKEY_CTX *ctx)

{
  int iVar1;
  
  iVar1 = __gmon_start__();
  return iVar1;
}



void FUN_00103020(void)

{
  (*(code *)(undefined *)0x0)();
  return;
}



void __cxa_finalize(void)

{
  __cxa_finalize();
  return;
}



void g_value_get_float(void)

{
  g_value_get_float();
  return;
}



void clutter_actor_get_transformed_size(void)

{
  clutter_actor_get_transformed_size();
  return;
}



void clutter_paint_context_get_framebuffer(void)

{
  clutter_paint_context_get_framebuffer();
  return;
}



void clutter_actor_box_scale(void)

{
  clutter_actor_box_scale();
  return;
}



void clutter_get_default_backend(void)

{
  clutter_get_default_backend();
  return;
}



void clutter_actor_box_get_size(void)

{
  clutter_actor_box_get_size();
  return;
}



void cogl_pipeline_add_layer_snippet(void)

{
  cogl_pipeline_add_layer_snippet();
  return;
}



void g_intern_static_string(void)

{
  g_intern_static_string();
  return;
}



void clutter_blit_node_new(void)

{
  clutter_blit_node_new();
  return;
}



void clutter_stage_view_get_scale(void)

{
  clutter_stage_view_get_scale();
  return;
}



void clutter_stage_view_get_layout(void)

{
  clutter_stage_view_get_layout();
  return;
}



// WARNING: Enum "AtkRole": Some values do not have unique names
// WARNING: Enum "GParamFlags": Some values do not have unique names

void gb_blur_effect_set_brightness(GbBlurEffect *self,float brightness)

{
  GParamSpec *pGVar1;
  gboolean gVar2;
  ClutterEffect *pCVar3;
  undefined8 uVar4;
  float fVar5;
  
  gVar2 = GB_IS_BLUR_EFFECT(self);
  if (gVar2 == 0) {
    g_return_if_fail_warning(0,"gb_blur_effect_set_brightness","GB_IS_BLUR_EFFECT (self)");
  }
  else {
    fVar5 = sanitize_float_property(brightness,0.0,1.0,1.0);
    if (self->brightness != fVar5) {
      self->brightness = fVar5;
      self->cache_flags = self->cache_flags & ~BLUR_APPLIED;
      if (self->actor != (ClutterActor *)0x0) {
        pCVar3 = CLUTTER_EFFECT(self);
        clutter_effect_queue_repaint(pCVar3);
      }
      pGVar1 = properties[2];
      uVar4 = g_type_check_instance_cast(self,0x50);
      g_object_notify_by_pspec(uVar4,pGVar1);
    }
  }
  return;
}



void cogl_pipeline_get_uniform_location(void)

{
  cogl_pipeline_get_uniform_location();
  return;
}



void g_object_unref(void)

{
  g_object_unref();
  return;
}



void g_param_spec_enum(void)

{
  g_param_spec_enum();
  return;
}



// WARNING: Enum "AtkRole": Some values do not have unique names
// WARNING: Enum "GParamFlags": Some values do not have unique names

void gb_liquid_glass_effect_set_highlight(GbLiquidGlassEffect *self,float highlight)

{
  GParamSpec *pGVar1;
  gboolean gVar2;
  ClutterEffect *pCVar3;
  undefined8 uVar4;
  float fVar5;
  
  gVar2 = GB_IS_LIQUID_GLASS_EFFECT(self);
  if (gVar2 == 0) {
    g_return_if_fail_warning
              (0,"gb_liquid_glass_effect_set_highlight","GB_IS_LIQUID_GLASS_EFFECT (self)");
  }
  else {
    fVar5 = sanitize_float_property(highlight,0.0,1.0,0.0);
    if (self->highlight != fVar5) {
      self->highlight = fVar5;
      self->cache_flags = self->cache_flags & ~BLUR_APPLIED;
      if (self->actor != (ClutterActor *)0x0) {
        pCVar3 = CLUTTER_EFFECT(self);
        clutter_effect_queue_repaint(pCVar3);
      }
      pGVar1 = properties[5];
      uVar4 = g_type_check_instance_cast(self,0x50);
      g_object_notify_by_pspec(uVar4,pGVar1);
    }
  }
  return;
}



void g_value_get_enum(void)

{
  g_value_get_enum();
  return;
}



void g_once_init_leave_pointer(void)

{
  g_once_init_leave_pointer();
  return;
}



void g_value_set_int(void)

{
  g_value_set_int();
  return;
}



// WARNING: Unknown calling convention -- yet parameter storage is locked

GType gb_blur_effect_get_type(void)

{
  long lVar1;
  bool bVar2;
  int iVar3;
  GType GVar4;
  long in_FS_OFFSET;
  
  lVar1 = *(long *)(in_FS_OFFSET + 0x28);
  if ((gb_blur_effect_get_type::static_g_define_type_id == 0) &&
     (iVar3 = g_once_init_enter_pointer(&gb_blur_effect_get_type::static_g_define_type_id),
     iVar3 != 0)) {
    bVar2 = true;
  }
  else {
    bVar2 = false;
  }
  if (bVar2) {
    GVar4 = gb_blur_effect_get_type_once();
    g_once_init_leave_pointer(&gb_blur_effect_get_type::static_g_define_type_id,GVar4);
  }
  if (lVar1 == *(long *)(in_FS_OFFSET + 0x28)) {
    return gb_blur_effect_get_type::static_g_define_type_id;
  }
                    // WARNING: Subroutine does not return
  __stack_chk_fail();
}



void clutter_actor_get_paint_opacity(void)

{
  clutter_actor_get_paint_opacity();
  return;
}



void cogl_color_init_from_4f(void)

{
  cogl_color_init_from_4f();
  return;
}



void cogl_snippet_set_pre(void)

{
  cogl_snippet_set_pre();
  return;
}



void clutter_transform_node_new(void)

{
  clutter_transform_node_new();
  return;
}



void clutter_actor_box_set_size(void)

{
  clutter_actor_box_set_size();
  return;
}



void g_enum_register_static(void)

{
  g_enum_register_static();
  return;
}



void graphene_matrix_init_scale(void)

{
  graphene_matrix_init_scale();
  return;
}



void cogl_framebuffer_set_projection_matrix(void)

{
  cogl_framebuffer_set_projection_matrix();
  return;
}



void clutter_blit_node_add_blit_rectangle(void)

{
  clutter_blit_node_add_blit_rectangle();
  return;
}



void clutter_paint_node_add_child(void)

{
  clutter_paint_node_add_child();
  return;
}



void clutter_actor_box_get_origin(void)

{
  clutter_actor_box_get_origin();
  return;
}



void cogl_texture_get_height(void)

{
  cogl_texture_get_height();
  return;
}



void clutter_blur_node_new(void)

{
  clutter_blur_node_new();
  return;
}



void g_param_spec_int(void)

{
  g_param_spec_int();
  return;
}



void clutter_actor_get_transformed_position(void)

{
  clutter_actor_get_transformed_position();
  return;
}



// WARNING: Enum "AtkRole": Some values do not have unique names
// WARNING: Enum "GParamFlags": Some values do not have unique names

void gb_liquid_glass_effect_set_brightness(GbLiquidGlassEffect *self,float brightness)

{
  GParamSpec *pGVar1;
  gboolean gVar2;
  ClutterEffect *pCVar3;
  undefined8 uVar4;
  float fVar5;
  
  gVar2 = GB_IS_LIQUID_GLASS_EFFECT(self);
  if (gVar2 == 0) {
    g_return_if_fail_warning
              (0,"gb_liquid_glass_effect_set_brightness","GB_IS_LIQUID_GLASS_EFFECT (self)");
  }
  else {
    fVar5 = sanitize_float_property(brightness,0.0,1.0,1.0);
    if (self->brightness != fVar5) {
      self->brightness = fVar5;
      self->cache_flags = self->cache_flags & ~BLUR_APPLIED;
      if (self->actor != (ClutterActor *)0x0) {
        pCVar3 = CLUTTER_EFFECT(self);
        clutter_effect_queue_repaint(pCVar3);
      }
      pGVar1 = properties[2];
      uVar4 = g_type_check_instance_cast(self,0x50);
      g_object_notify_by_pspec(uVar4,pGVar1);
    }
  }
  return;
}



void cogl_pipeline_new(void)

{
  cogl_pipeline_new();
  return;
}



// WARNING: Enum "AtkRole": Some values do not have unique names
// WARNING: Enum "GParamFlags": Some values do not have unique names

void gb_liquid_glass_effect_set_mode(GbLiquidGlassEffect *self,GbBlurMode mode)

{
  GParamSpec *pGVar1;
  gboolean gVar2;
  ClutterEffect *pCVar3;
  undefined8 uVar4;
  GbBlurMode GStack_24;
  
  gVar2 = GB_IS_LIQUID_GLASS_EFFECT(self);
  if (gVar2 == 0) {
    g_return_if_fail_warning(0,"gb_liquid_glass_effect_set_mode","GB_IS_LIQUID_GLASS_EFFECT (self)")
    ;
  }
  else {
    gVar2 = is_valid_mode(mode);
    GStack_24 = mode;
    if (gVar2 == 0) {
      GStack_24 = GB_BLUR_MODE_ACTOR;
    }
    if (GStack_24 != self->mode) {
      self->mode = GStack_24;
      self->cache_flags = self->cache_flags & ~BLUR_APPLIED;
      if (GStack_24 == GB_BLUR_MODE_ACTOR) {
        clear_framebuffer_data(&self->background_fb);
      }
      if (self->actor != (ClutterActor *)0x0) {
        pCVar3 = CLUTTER_EFFECT(self);
        clutter_effect_queue_repaint(pCVar3);
      }
      pGVar1 = properties[3];
      uVar4 = g_type_check_instance_cast(self,0x50);
      g_object_notify_by_pspec(uVar4,pGVar1);
    }
  }
  return;
}



void cogl_pipeline_set_layer_null_texture(void)

{
  cogl_pipeline_set_layer_null_texture();
  return;
}



void cogl_snippet_new(void)

{
  cogl_snippet_new();
  return;
}



void cogl_pipeline_set_uniform_1f(void)

{
  cogl_pipeline_set_uniform_1f();
  return;
}



void clutter_actor_meta_get_type(void)

{
  clutter_actor_meta_get_type();
  return;
}



void g_object_new(void)

{
  g_object_new();
  return;
}



void clutter_effect_get_type(void)

{
  clutter_effect_get_type();
  return;
}



void cogl_pipeline_set_layer_filters(void)

{
  cogl_pipeline_set_layer_filters();
  return;
}



void cogl_pipeline_add_snippet(void)

{
  cogl_pipeline_add_snippet();
  return;
}



void clutter_layer_node_new_to_framebuffer(void)

{
  clutter_layer_node_new_to_framebuffer();
  return;
}



void clutter_paint_node_set_static_name(void)

{
  clutter_paint_node_set_static_name();
  return;
}



// WARNING: Enum "AtkRole": Some values do not have unique names
// WARNING: Enum "GParamFlags": Some values do not have unique names

void gb_blur_effect_set_mode(GbBlurEffect *self,GbBlurMode mode)

{
  GParamSpec *pGVar1;
  gboolean gVar2;
  ClutterEffect *pCVar3;
  undefined8 uVar4;
  GbBlurMode GStack_24;
  
  gVar2 = GB_IS_BLUR_EFFECT(self);
  if (gVar2 == 0) {
    g_return_if_fail_warning(0,"gb_blur_effect_set_mode","GB_IS_BLUR_EFFECT (self)");
  }
  else {
    gVar2 = is_valid_mode(mode);
    GStack_24 = mode;
    if (gVar2 == 0) {
      GStack_24 = GB_BLUR_MODE_ACTOR;
    }
    if (GStack_24 != self->mode) {
      self->mode = GStack_24;
      self->cache_flags = self->cache_flags & ~BLUR_APPLIED;
      if (GStack_24 == GB_BLUR_MODE_ACTOR) {
        clear_framebuffer_data(&self->background_fb);
      }
      if (self->actor != (ClutterActor *)0x0) {
        pCVar3 = CLUTTER_EFFECT(self);
        clutter_effect_queue_repaint(pCVar3);
      }
      pGVar1 = properties[3];
      uVar4 = g_type_check_instance_cast(self,0x50);
      g_object_notify_by_pspec(uVar4,pGVar1);
    }
  }
  return;
}



void clutter_actor_get_allocation_box(void)

{
  clutter_actor_get_allocation_box();
  return;
}



void g_type_check_class_cast(void)

{
  g_type_check_class_cast();
  return;
}



void clutter_blit_node_get_type(void)

{
  clutter_blit_node_get_type();
  return;
}



void graphene_matrix_init_translate(void)

{
  graphene_matrix_init_translate();
  return;
}



void clutter_pipeline_node_new(void)

{
  clutter_pipeline_node_new();
  return;
}



// WARNING: Unknown calling convention -- yet parameter storage is locked

float floorf(float __x)

{
  float fVar1;
  
  fVar1 = floorf(__x);
  return fVar1;
}



void g_value_set_float(void)

{
  g_value_set_float();
  return;
}



void g_object_class_install_properties(void)

{
  g_object_class_install_properties();
  return;
}



void g_param_spec_float(void)

{
  g_param_spec_float();
  return;
}



void clutter_actor_box_clamp_to_pixel(void)

{
  clutter_actor_box_clamp_to_pixel();
  return;
}



void g_value_set_enum(void)

{
  g_value_set_enum();
  return;
}



void cogl_texture_get_width(void)

{
  cogl_texture_get_width();
  return;
}



void g_return_if_fail_warning(void)

{
  g_return_if_fail_warning();
  return;
}



// WARNING: Enum "AtkRole": Some values do not have unique names
// WARNING: Enum "GParamFlags": Some values do not have unique names

void gb_liquid_glass_effect_set_refraction(GbLiquidGlassEffect *self,float refraction)

{
  GParamSpec *pGVar1;
  gboolean gVar2;
  ClutterEffect *pCVar3;
  undefined8 uVar4;
  float fVar5;
  
  gVar2 = GB_IS_LIQUID_GLASS_EFFECT(self);
  if (gVar2 == 0) {
    g_return_if_fail_warning
              (0,"gb_liquid_glass_effect_set_refraction","GB_IS_LIQUID_GLASS_EFFECT (self)");
  }
  else {
    fVar5 = sanitize_float_property(refraction,0.0,80.0,0.0);
    if (self->refraction != fVar5) {
      self->refraction = fVar5;
      self->cache_flags = self->cache_flags & ~BLUR_APPLIED;
      if (self->actor != (ClutterActor *)0x0) {
        pCVar3 = CLUTTER_EFFECT(self);
        clutter_effect_queue_repaint(pCVar3);
      }
      pGVar1 = properties[6];
      uVar4 = g_type_check_instance_cast(self,0x50);
      g_object_notify_by_pspec(uVar4,pGVar1);
    }
  }
  return;
}



// WARNING: Enum "AtkRole": Some values do not have unique names
// WARNING: Enum "GParamFlags": Some values do not have unique names

void gb_liquid_glass_effect_set_depth(GbLiquidGlassEffect *self,float depth)

{
  GParamSpec *pGVar1;
  gboolean gVar2;
  ClutterEffect *pCVar3;
  undefined8 uVar4;
  float fVar5;
  
  gVar2 = GB_IS_LIQUID_GLASS_EFFECT(self);
  if (gVar2 == 0) {
    g_return_if_fail_warning
              (0,"gb_liquid_glass_effect_set_depth","GB_IS_LIQUID_GLASS_EFFECT (self)");
  }
  else {
    fVar5 = sanitize_float_property(depth,0.0,24.0,6.9);
    if (self->depth != fVar5) {
      self->depth = fVar5;
      self->cache_flags = self->cache_flags & ~BLUR_APPLIED;
      if (self->actor != (ClutterActor *)0x0) {
        pCVar3 = CLUTTER_EFFECT(self);
        clutter_effect_queue_repaint(pCVar3);
      }
      pGVar1 = properties[7];
      uVar4 = g_type_check_instance_cast(self,0x50);
      g_object_notify_by_pspec(uVar4,pGVar1);
    }
  }
  return;
}



void clutter_actor_get_size(void)

{
  clutter_actor_get_size();
  return;
}



void cogl_pipeline_copy(void)

{
  cogl_pipeline_copy();
  return;
}



void cogl_pipeline_set_uniform_float(void)

{
  cogl_pipeline_set_uniform_float();
  return;
}



void g_type_check_instance_is_a(void)

{
  g_type_check_instance_is_a();
  return;
}



void cogl_pipeline_set_color(void)

{
  cogl_pipeline_set_color();
  return;
}



// WARNING: Enum "AtkRole": Some values do not have unique names
// WARNING: Enum "GParamFlags": Some values do not have unique names

void gb_blur_effect_set_corner_radius(GbBlurEffect *self,float corner_radius)

{
  GParamSpec *pGVar1;
  gboolean gVar2;
  ClutterEffect *pCVar3;
  undefined8 uVar4;
  float fVar5;
  
  gVar2 = GB_IS_BLUR_EFFECT(self);
  if (gVar2 == 0) {
    g_return_if_fail_warning(0,"gb_blur_effect_set_corner_radius","GB_IS_BLUR_EFFECT (self)");
  }
  else {
    fVar5 = sanitize_float_property(corner_radius,0.0,3.4028235e+38,0.0);
    if (self->corner_radius != fVar5) {
      self->corner_radius = fVar5;
      self->cache_flags = self->cache_flags & ~BLUR_APPLIED;
      if (self->actor != (ClutterActor *)0x0) {
        pCVar3 = CLUTTER_EFFECT(self);
        clutter_effect_queue_repaint(pCVar3);
      }
      pGVar1 = properties[4];
      uVar4 = g_type_check_instance_cast(self,0x50);
      g_object_notify_by_pspec(uVar4,pGVar1);
    }
  }
  return;
}



void cogl_pipeline_set_layer_wrap_mode(void)

{
  cogl_pipeline_set_layer_wrap_mode();
  return;
}



void cogl_offscreen_new_with_texture(void)

{
  cogl_offscreen_new_with_texture();
  return;
}



void g_type_name(void)

{
  g_type_name();
  return;
}



void clutter_actor_node_new(void)

{
  clutter_actor_node_new();
  return;
}



void g_type_check_instance_cast(void)

{
  g_type_check_instance_cast();
  return;
}



void __stack_chk_fail(void)

{
                    // WARNING: Subroutine does not return
  __stack_chk_fail();
}



void cogl_framebuffer_get_type(void)

{
  cogl_framebuffer_get_type();
  return;
}



void g_type_register_static_simple(void)

{
  g_type_register_static_simple();
  return;
}



// WARNING: Enum "AtkRole": Some values do not have unique names
// WARNING: Enum "GParamFlags": Some values do not have unique names

void gb_liquid_glass_effect_set_corner_radius(GbLiquidGlassEffect *self,float corner_radius)

{
  GParamSpec *pGVar1;
  gboolean gVar2;
  ClutterEffect *pCVar3;
  undefined8 uVar4;
  float fVar5;
  
  gVar2 = GB_IS_LIQUID_GLASS_EFFECT(self);
  if (gVar2 == 0) {
    g_return_if_fail_warning
              (0,"gb_liquid_glass_effect_set_corner_radius","GB_IS_LIQUID_GLASS_EFFECT (self)");
  }
  else {
    fVar5 = sanitize_float_property(corner_radius,0.0,3.4028235e+38,0.0);
    if (self->corner_radius != fVar5) {
      self->corner_radius = fVar5;
      self->cache_flags = self->cache_flags & ~BLUR_APPLIED;
      if (self->actor != (ClutterActor *)0x0) {
        pCVar3 = CLUTTER_EFFECT(self);
        clutter_effect_queue_repaint(pCVar3);
      }
      pGVar1 = properties[4];
      uVar4 = g_type_check_instance_cast(self,0x50);
      g_object_notify_by_pspec(uVar4,pGVar1);
    }
  }
  return;
}



void clutter_paint_node_unref(void)

{
  clutter_paint_node_unref();
  return;
}



void graphene_matrix_scale(void)

{
  graphene_matrix_scale();
  return;
}



void clutter_backend_get_cogl_context(void)

{
  clutter_backend_get_cogl_context();
  return;
}



void g_object_notify_by_pspec(void)

{
  g_object_notify_by_pspec();
  return;
}



void cogl_texture_2d_new_with_size(void)

{
  cogl_texture_2d_new_with_size();
  return;
}



void clutter_paint_node_add_rectangle(void)

{
  clutter_paint_node_add_rectangle();
  return;
}



// WARNING: Unknown calling convention -- yet parameter storage is locked

GType gb_blur_mode_get_type(void)

{
  undefined8 uVar1;
  
  if (gb_blur_mode_get_type::etype == 0) {
    uVar1 = g_intern_static_string("GbBlurMode");
    gb_blur_mode_get_type::etype =
         g_enum_register_static(uVar1,gb_blur_mode_get_type::lexical_block_0::values);
  }
  return gb_blur_mode_get_type::etype;
}



void clutter_effect_queue_repaint(void)

{
  clutter_effect_queue_repaint();
  return;
}



void g_value_get_int(void)

{
  g_value_get_int();
  return;
}



void cogl_pipeline_set_layer_texture(void)

{
  cogl_pipeline_set_layer_texture();
  return;
}



void g_once_init_enter_pointer(void)

{
  g_once_init_enter_pointer();
  return;
}



// WARNING: Enum "AtkRole": Some values do not have unique names
// WARNING: Enum "GParamFlags": Some values do not have unique names

void gb_liquid_glass_effect_set_radius(GbLiquidGlassEffect *self,int radius)

{
  GParamSpec *pGVar1;
  gboolean gVar2;
  ClutterEffect *pCVar3;
  undefined8 uVar4;
  
  gVar2 = GB_IS_LIQUID_GLASS_EFFECT(self);
  if (gVar2 == 0) {
    g_return_if_fail_warning
              (0,"gb_liquid_glass_effect_set_radius","GB_IS_LIQUID_GLASS_EFFECT (self)");
  }
  else {
    if (radius < 0) {
      radius = 0;
    }
    if (radius != self->radius) {
      self->radius = radius;
      self->cache_flags = self->cache_flags & ~BLUR_APPLIED;
      if (self->actor != (ClutterActor *)0x0) {
        pCVar3 = CLUTTER_EFFECT(self);
        clutter_effect_queue_repaint(pCVar3);
      }
      pGVar1 = properties[1];
      uVar4 = g_type_check_instance_cast(self,0x50);
      g_object_notify_by_pspec(uVar4,pGVar1);
    }
  }
  return;
}



// WARNING: Unknown calling convention -- yet parameter storage is locked

GType gb_liquid_glass_effect_get_type(void)

{
  long lVar1;
  bool bVar2;
  int iVar3;
  GType GVar4;
  long in_FS_OFFSET;
  
  lVar1 = *(long *)(in_FS_OFFSET + 0x28);
  if ((gb_liquid_glass_effect_get_type::static_g_define_type_id == 0) &&
     (iVar3 = g_once_init_enter_pointer(&gb_liquid_glass_effect_get_type::static_g_define_type_id),
     iVar3 != 0)) {
    bVar2 = true;
  }
  else {
    bVar2 = false;
  }
  if (bVar2) {
    GVar4 = gb_liquid_glass_effect_get_type_once();
    g_once_init_leave_pointer(&gb_liquid_glass_effect_get_type::static_g_define_type_id,GVar4);
  }
  if (lVar1 == *(long *)(in_FS_OFFSET + 0x28)) {
    return gb_liquid_glass_effect_get_type::static_g_define_type_id;
  }
                    // WARNING: Subroutine does not return
  __stack_chk_fail();
}



void clutter_actor_box_set_origin(void)

{
  clutter_actor_box_set_origin();
  return;
}



void clutter_actor_meta_get_actor(void)

{
  clutter_actor_meta_get_actor();
  return;
}



void g_type_class_peek_parent(void)

{
  g_type_class_peek_parent();
  return;
}



void g_log(void)

{
  g_log();
  return;
}



void g_type_class_adjust_private_offset(void)

{
  g_type_class_adjust_private_offset();
  return;
}



void clutter_paint_context_get_stage_view(void)

{
  clutter_paint_context_get_stage_view();
  return;
}



// WARNING: Enum "AtkRole": Some values do not have unique names
// WARNING: Enum "GParamFlags": Some values do not have unique names

void gb_blur_effect_set_radius(GbBlurEffect *self,int radius)

{
  GParamSpec *pGVar1;
  gboolean gVar2;
  ClutterEffect *pCVar3;
  undefined8 uVar4;
  
  gVar2 = GB_IS_BLUR_EFFECT(self);
  if (gVar2 == 0) {
    g_return_if_fail_warning(0,"gb_blur_effect_set_radius","GB_IS_BLUR_EFFECT (self)");
  }
  else {
    if (radius < 0) {
      radius = 0;
    }
    if (radius != self->radius) {
      self->radius = radius;
      self->cache_flags = self->cache_flags & ~BLUR_APPLIED;
      if (self->actor != (ClutterActor *)0x0) {
        pCVar3 = CLUTTER_EFFECT(self);
        clutter_effect_queue_repaint(pCVar3);
      }
      pGVar1 = properties[1];
      uVar4 = g_type_check_instance_cast(self,0x50);
      g_object_notify_by_pspec(uVar4,pGVar1);
    }
  }
  return;
}



// WARNING: Removing unreachable block (ram,0x00103cb3)
// WARNING: Removing unreachable block (ram,0x00103cbf)

void deregister_tm_clones(void)

{
  return;
}



// WARNING: Removing unreachable block (ram,0x00103cf4)
// WARNING: Removing unreachable block (ram,0x00103d00)

void register_tm_clones(void)

{
  return;
}



void __do_global_dtors_aux(void)

{
  if (completed_0 != '\0') {
    return;
  }
  __cxa_finalize(__dso_handle);
  deregister_tm_clones();
  completed_0 = 1;
  return;
}



void frame_dummy(void)

{
  register_tm_clones();
  return;
}



gpointer g_steal_pointer(gpointer pp)

{
  gpointer pvVar1;
  gpointer pp_local;
  gpointer *ptr;
  gpointer ref;
  
  pvVar1 = *(gpointer *)pp;
  *(undefined8 *)pp = 0;
  return pvVar1;
}



CoglFramebuffer * COGL_FRAMEBUFFER(gpointer ptr)

{
  undefined8 uVar1;
  CoglFramebuffer *pCVar2;
  gpointer ptr_local;
  
  uVar1 = cogl_framebuffer_get_type();
  pCVar2 = (CoglFramebuffer *)g_type_check_instance_cast(ptr,uVar1);
  return pCVar2;
}



// WARNING: Enum "GParamFlags": Some values do not have unique names
// WARNING: Enum "AtkRole": Some values do not have unique names

ClutterActorMetaClass * CLUTTER_ACTOR_META_CLASS(gpointer ptr)

{
  undefined8 uVar1;
  ClutterActorMetaClass *pCVar2;
  gpointer ptr_local;
  
  uVar1 = clutter_actor_meta_get_type();
  pCVar2 = (ClutterActorMetaClass *)g_type_check_class_cast(ptr,uVar1);
  return pCVar2;
}



ClutterEffect * CLUTTER_EFFECT(gpointer ptr)

{
  undefined8 uVar1;
  ClutterEffect *pCVar2;
  gpointer ptr_local;
  
  uVar1 = clutter_effect_get_type();
  pCVar2 = (ClutterEffect *)g_type_check_instance_cast(ptr,uVar1);
  return pCVar2;
}



// WARNING: Enum "GParamFlags": Some values do not have unique names
// WARNING: Enum "AtkRole": Some values do not have unique names

ClutterEffectClass * CLUTTER_EFFECT_CLASS(gpointer ptr)

{
  undefined8 uVar1;
  ClutterEffectClass *pCVar2;
  gpointer ptr_local;
  
  uVar1 = clutter_effect_get_type();
  pCVar2 = (ClutterEffectClass *)g_type_check_class_cast(ptr,uVar1);
  return pCVar2;
}



void glib_autoptr_clear_ClutterPaintNode(ClutterPaintNode *_ptr)

{
  ClutterPaintNode *_ptr_local;
  
  if (_ptr != (ClutterPaintNode *)0x0) {
    clutter_paint_node_unref(_ptr);
  }
  return;
}



void glib_autoptr_cleanup_ClutterPaintNode(ClutterPaintNode **_ptr)

{
  ClutterPaintNode **_ptr_local;
  
  glib_autoptr_clear_ClutterPaintNode(*_ptr);
  return;
}



// WARNING: Enum "AtkRole": Some values do not have unique names

GbBlurEffect * GB_BLUR_EFFECT(gpointer ptr)

{
  GType GVar1;
  GbBlurEffect *pGVar2;
  gpointer ptr_local;
  
  GVar1 = gb_blur_effect_get_type();
  pGVar2 = (GbBlurEffect *)g_type_check_instance_cast(ptr,GVar1);
  return pGVar2;
}



gboolean GB_IS_BLUR_EFFECT(gpointer ptr)

{
  GType GVar1;
  gpointer ptr_local;
  gboolean __r;
  GTypeInstance *__inst;
  GType __t;
  
  GVar1 = gb_blur_effect_get_type();
  if (ptr == (gpointer)0x0) {
    __r = 0;
  }
  else if ((*(long *)ptr == 0) || (GVar1 != **(GType **)ptr)) {
    __r = g_type_check_instance_is_a(ptr,GVar1);
  }
  else {
    __r = 1;
  }
  return __r;
}



// WARNING: Enum "GParamFlags": Some values do not have unique names
// WARNING: Enum "AtkRole": Some values do not have unique names

void gb_blur_effect_class_intern_init(gpointer klass)

{
  gpointer klass_local;
  
  gb_blur_effect_parent_class = (gpointer)g_type_class_peek_parent(klass);
  if (GbBlurEffect_private_offset != 0) {
    g_type_class_adjust_private_offset(klass,&GbBlurEffect_private_offset);
  }
  gb_blur_effect_class_init(klass);
  return;
}



// WARNING: Unknown calling convention -- yet parameter storage is locked

GType gb_blur_effect_get_type(void)

{
  long lVar1;
  bool bVar2;
  int iVar3;
  GType GVar4;
  long in_FS_OFFSET;
  GType gapg_temp_newval;
  GType *gapg_temp_atomic;
  GType g_define_type_id;
  
  lVar1 = *(long *)(in_FS_OFFSET + 0x28);
  if (gb_blur_effect_get_type::static_g_define_type_id == 0) {
    iVar3 = g_once_init_enter_pointer(&gb_blur_effect_get_type::static_g_define_type_id);
    if (iVar3 != 0) {
      bVar2 = true;
      goto LAB_00103f93;
    }
  }
  bVar2 = false;
LAB_00103f93:
  if (bVar2) {
    GVar4 = gb_blur_effect_get_type_once();
    g_once_init_leave_pointer(&gb_blur_effect_get_type::static_g_define_type_id,GVar4);
  }
  if (lVar1 != *(long *)(in_FS_OFFSET + 0x28)) {
                    // WARNING: Subroutine does not return
    __stack_chk_fail();
  }
  return gb_blur_effect_get_type::static_g_define_type_id;
}



// WARNING: Unknown calling convention -- yet parameter storage is locked
// WARNING: Enum "AtkRole": Some values do not have unique names

GType gb_blur_effect_get_type_once(void)

{
  undefined8 uVar1;
  undefined8 uVar2;
  GType GVar3;
  GType g_define_type_id;
  
  uVar1 = g_intern_static_string("GbBlurEffect");
  uVar2 = clutter_effect_get_type();
  GVar3 = g_type_register_static_simple
                    (uVar2,uVar1,200,gb_blur_effect_class_intern_init,0xb8,gb_blur_effect_init,0);
  return GVar3;
}



// WARNING: Unknown calling convention -- yet parameter storage is locked

CoglPipeline * create_base_pipeline(void)

{
  undefined8 uVar1;
  CoglPipeline *pCVar2;
  ClutterBackend *backend;
  CoglContext *ctx;
  
  if (create_base_pipeline::base_pipeline == (CoglPipeline *)0x0) {
    uVar1 = clutter_get_default_backend();
    uVar1 = clutter_backend_get_cogl_context(uVar1);
    create_base_pipeline::base_pipeline = (CoglPipeline *)cogl_pipeline_new(uVar1);
    cogl_pipeline_set_layer_null_texture(create_base_pipeline::base_pipeline,0);
    cogl_pipeline_set_layer_filters(create_base_pipeline::base_pipeline,0,0x2601,0x2601);
    cogl_pipeline_set_layer_wrap_mode(create_base_pipeline::base_pipeline,0,0x812f);
  }
  pCVar2 = (CoglPipeline *)cogl_pipeline_copy(create_base_pipeline::base_pipeline);
  return pCVar2;
}



// WARNING: Unknown calling convention -- yet parameter storage is locked

CoglPipeline * create_brightness_pipeline(void)

{
  undefined8 uVar1;
  CoglPipeline *pCVar2;
  CoglSnippet *snippet;
  
  if (create_brightness_pipeline::brightness_pipeline == (CoglPipeline *)0x0) {
    create_brightness_pipeline::brightness_pipeline = create_base_pipeline();
    uVar1 = cogl_snippet_new(0x800,brightness_glsl_declarations,brightness_glsl);
    cogl_pipeline_add_snippet(create_brightness_pipeline::brightness_pipeline,uVar1);
    g_object_unref(uVar1);
  }
  pCVar2 = (CoglPipeline *)cogl_pipeline_copy(create_brightness_pipeline::brightness_pipeline);
  return pCVar2;
}



// WARNING: Unknown calling convention -- yet parameter storage is locked

CoglPipeline * create_mask_pipeline(void)

{
  undefined8 uVar1;
  CoglPipeline *pCVar2;
  CoglSnippet *snippet;
  
  if (create_mask_pipeline::mask_pipeline == (CoglPipeline *)0x0) {
    create_mask_pipeline::mask_pipeline = create_base_pipeline();
    uVar1 = cogl_snippet_new(0x800,mask_glsl_declarations,mask_glsl);
    cogl_pipeline_add_snippet(create_mask_pipeline::mask_pipeline,uVar1);
    g_object_unref(uVar1);
  }
  pCVar2 = (CoglPipeline *)cogl_pipeline_copy(create_mask_pipeline::mask_pipeline);
  return pCVar2;
}



void clear_framebuffer_data(FramebufferData *fb_data)

{
  CoglFramebuffer *pCVar1;
  CoglTexture *pCVar2;
  FramebufferData *fb_data_local;
  CoglFramebuffer **_pp;
  CoglFramebuffer *_ptr;
  CoglTexture **_pp_1;
  CoglTexture *_ptr_1;
  
  if (fb_data->pipeline != (CoglPipeline *)0x0) {
    cogl_pipeline_set_layer_null_texture(fb_data->pipeline,0);
  }
  pCVar1 = fb_data->framebuffer;
  fb_data->framebuffer = (CoglFramebuffer *)0x0;
  if (pCVar1 != (CoglFramebuffer *)0x0) {
    g_object_unref(pCVar1);
  }
  pCVar2 = fb_data->texture;
  fb_data->texture = (CoglTexture *)0x0;
  if (pCVar2 != (CoglTexture *)0x0) {
    g_object_unref(pCVar2);
  }
  return;
}



gboolean is_valid_dimension(float value)

{
  gboolean gVar1;
  float value_local;
  
  if (((3.4028235e+38 < ABS(value)) || (value < 1.0)) || (4.2949673e+09 < value)) {
    gVar1 = 0;
  }
  else {
    gVar1 = 1;
  }
  return gVar1;
}



float sanitize_float_property(float value,float min,float max,float fallback)

{
  float fallback_local;
  float max_local;
  float min_local;
  float value_local;
  
  if (((ABS(value) <= 3.4028235e+38) && (fallback = max, value <= max)) &&
     (fallback = value, value < min)) {
    fallback = min;
  }
  return fallback;
}



gboolean is_valid_mode(GbBlurMode mode)

{
  gboolean gVar1;
  GbBlurMode mode_local;
  
  if ((mode == GB_BLUR_MODE_ACTOR) || (mode == GB_BLUR_MODE_BACKGROUND)) {
    gVar1 = 1;
  }
  else {
    gVar1 = 0;
  }
  return gVar1;
}



// WARNING: Enum "AtkRole": Some values do not have unique names

void update_brightness(GbBlurEffect *self,uint8_t paint_opacity)

{
  long lVar1;
  long in_FS_OFFSET;
  undefined1 auVar2 [16];
  undefined1 auVar3 [16];
  uint8_t paint_opacity_local;
  GbBlurEffect *self_local;
  CoglColor color;
  
  lVar1 = *(long *)(in_FS_OFFSET + 0x28);
  auVar3._4_12_ = SUB1612((undefined1  [16])0x0,4);
  auVar3._0_4_ = (float)paint_opacity / 255.0;
  auVar2._4_12_ = SUB1612((undefined1  [16])0x0,4);
  auVar2._0_4_ = (float)paint_opacity / 255.0;
  cogl_color_init_from_4f
            ((float)paint_opacity / 255.0,(float)paint_opacity / 255.0,auVar2._0_8_,auVar3._0_8_,
             &color);
  cogl_pipeline_set_color((self->brightness_fb).pipeline,&color);
  if (-1 < self->brightness_uniform) {
    cogl_pipeline_set_uniform_1f
              (self->brightness,(self->brightness_fb).pipeline,self->brightness_uniform);
  }
  if (lVar1 != *(long *)(in_FS_OFFSET + 0x28)) {
                    // WARNING: Subroutine does not return
    __stack_chk_fail();
  }
  return;
}



// WARNING: Variable defined which should be unmapped: height_local
// WARNING: Enum "AtkRole": Some values do not have unique names

void update_mask_uniforms(GbBlurEffect *self,float width,float height)

{
  long lVar1;
  undefined8 in_R9;
  long in_FS_OFFSET;
  float height_local;
  float width_local;
  GbBlurEffect *self_local;
  float size [2];
  
  lVar1 = *(long *)(in_FS_OFFSET + 0x28);
  if ((self->mask_fb).pipeline != (CoglPipeline *)0x0) {
    if (-1 < self->corner_radius_uniform) {
      cogl_pipeline_set_uniform_1f
                (self->corner_radius,(self->mask_fb).pipeline,self->corner_radius_uniform);
    }
    if (-1 < self->mask_size_uniform) {
      size[0] = width;
      size[1] = height;
      cogl_pipeline_set_uniform_float
                ((self->mask_fb).pipeline,self->mask_size_uniform,2,1,size,in_R9,height);
    }
  }
  if (lVar1 != *(long *)(in_FS_OFFSET + 0x28)) {
                    // WARNING: Subroutine does not return
    __stack_chk_fail();
  }
  return;
}



void setup_projection_matrix(CoglFramebuffer *framebuffer,float width,float height)

{
  long lVar1;
  long in_FS_OFFSET;
  float height_local;
  float width_local;
  CoglFramebuffer *framebuffer_local;
  float local_64;
  float local_60;
  undefined4 local_5c;
  graphene_matrix_t projection;
  
  lVar1 = *(long *)(in_FS_OFFSET + 0x28);
  local_64 = -width / 2.0;
  local_60 = -height / 2.0;
  local_5c = 0;
  graphene_matrix_init_translate(&projection,&local_64);
  graphene_matrix_scale(2.0 / width,-2.0 / height,0x3f800000,&projection);
  cogl_framebuffer_set_projection_matrix(framebuffer,&projection);
  if (lVar1 != *(long *)(in_FS_OFFSET + 0x28)) {
                    // WARNING: Subroutine does not return
    __stack_chk_fail();
  }
  return;
}



gboolean update_fbo(FramebufferData *data,float width,float height,float downscale_factor)

{
  gboolean gVar1;
  long lVar2;
  CoglTexture *pCVar3;
  gpointer ptr;
  CoglFramebuffer *pCVar4;
  float value;
  float value_00;
  float downscale_factor_local;
  float height_local;
  float width_local;
  FramebufferData *data_local;
  float new_width;
  float new_height;
  ClutterBackend *backend;
  CoglContext *ctx;
  
  if ((((data->pipeline == (CoglPipeline *)0x0) || (gVar1 = is_valid_dimension(width), gVar1 == 0))
      || (gVar1 = is_valid_dimension(height), gVar1 == 0)) ||
     ((3.4028235e+38 < ABS(downscale_factor) || (downscale_factor < 1.0)))) {
    return 0;
  }
  value = floorf(width / downscale_factor);
  value_00 = floorf(height / downscale_factor);
  gVar1 = is_valid_dimension(value);
  if ((gVar1 == 0) || (gVar1 = is_valid_dimension(value_00), gVar1 == 0)) {
    return 0;
  }
  lVar2 = clutter_get_default_backend();
  if (lVar2 == 0) {
    return 0;
  }
  lVar2 = clutter_backend_get_cogl_context(lVar2);
  if (lVar2 == 0) {
    return 0;
  }
  clear_framebuffer_data(data);
  pCVar3 = (CoglTexture *)cogl_texture_2d_new_with_size(lVar2,(int)value,(int)value_00);
  data->texture = pCVar3;
  if (data->texture == (CoglTexture *)0x0) {
    return 0;
  }
  cogl_pipeline_set_layer_texture(data->pipeline,0,data->texture);
  ptr = (gpointer)cogl_offscreen_new_with_texture(data->texture);
  pCVar4 = COGL_FRAMEBUFFER(ptr);
  data->framebuffer = pCVar4;
  if (data->framebuffer == (CoglFramebuffer *)0x0) {
    g_log(0,0x10,"%s: Unable to create an Offscreen buffer","../src/rounded-blur-effect.c:310");
    clear_framebuffer_data(data);
    return 0;
  }
  setup_projection_matrix(data->framebuffer,value,value_00);
  return 1;
}



// WARNING: Enum "AtkRole": Some values do not have unique names

gboolean update_actor_fbo(GbBlurEffect *self,float width,float height,float downscale_factor)

{
  gboolean gVar1;
  float downscale_factor_local;
  float height_local;
  float width_local;
  GbBlurEffect *self_local;
  
  if ((((self->tex_width == width) && (self->tex_height == height)) &&
      (self->downscale_factor == downscale_factor)) &&
     ((self->actor_fb).framebuffer != (CoglFramebuffer *)0x0)) {
    gVar1 = 1;
  }
  else {
    self->cache_flags = self->cache_flags & ~ACTOR_PAINTED;
    gVar1 = update_fbo(&self->actor_fb,width,height,downscale_factor);
  }
  return gVar1;
}



// WARNING: Enum "AtkRole": Some values do not have unique names

gboolean update_brightness_fbo(GbBlurEffect *self,float width,float height,float downscale_factor)

{
  gboolean gVar1;
  float downscale_factor_local;
  float height_local;
  float width_local;
  GbBlurEffect *self_local;
  
  if ((((self->tex_width == width) && (self->tex_height == height)) &&
      (self->downscale_factor == downscale_factor)) &&
     ((self->brightness_fb).framebuffer != (CoglFramebuffer *)0x0)) {
    gVar1 = 1;
  }
  else {
    gVar1 = update_fbo(&self->brightness_fb,width,height,downscale_factor);
  }
  return gVar1;
}



// WARNING: Enum "AtkRole": Some values do not have unique names

gboolean update_background_fbo(GbBlurEffect *self,float width,float height)

{
  gboolean gVar1;
  float height_local;
  float width_local;
  GbBlurEffect *self_local;
  
  if (((self->tex_width == width) && (self->tex_height == height)) &&
     ((self->background_fb).framebuffer != (CoglFramebuffer *)0x0)) {
    gVar1 = 1;
  }
  else {
    gVar1 = update_fbo(&self->background_fb,width,height,1.0);
  }
  return gVar1;
}



// WARNING: Enum "AtkRole": Some values do not have unique names

gboolean update_mask_fbo(GbBlurEffect *self,float width,float height,float downscale_factor)

{
  gboolean gVar1;
  float downscale_factor_local;
  float height_local;
  float width_local;
  GbBlurEffect *self_local;
  
  if ((((self->tex_width == width) && (self->tex_height == height)) &&
      (self->downscale_factor == downscale_factor)) &&
     ((self->mask_fb).framebuffer != (CoglFramebuffer *)0x0)) {
    gVar1 = 1;
  }
  else {
    gVar1 = update_fbo(&self->mask_fb,width,height,downscale_factor);
  }
  return gVar1;
}



float calculate_downscale_factor(float width,float height,float radius)

{
  float radius_local;
  float height_local;
  float width_local;
  float downscale_factor;
  float scaled_width;
  float scaled_height;
  float scaled_radius;
  
  downscale_factor = 1.0;
  scaled_width = width;
  scaled_height = height;
  scaled_radius = radius;
  while (((12.0 < scaled_radius && (256.0 < scaled_width)) && (256.0 < scaled_height))) {
    downscale_factor = downscale_factor + downscale_factor;
    scaled_width = width / downscale_factor;
    scaled_radius = radius / downscale_factor;
    scaled_height = height / downscale_factor;
  }
  return downscale_factor;
}



// WARNING: Enum "AtkRole": Some values do not have unique names
// WARNING: Enum "GParamFlags": Some values do not have unique names

void gb_blur_effect_set_actor(ClutterActorMeta *meta,ClutterActor *actor)

{
  GbBlurEffect *pGVar1;
  ClutterActorMetaClass *pCVar2;
  ClutterActor *pCVar3;
  ClutterActor *actor_local;
  ClutterActorMeta *meta_local;
  GbBlurEffect *self;
  ClutterActorMetaClass *meta_class;
  
  pGVar1 = GB_BLUR_EFFECT(meta);
  pCVar2 = CLUTTER_ACTOR_META_CLASS(gb_blur_effect_parent_class);
  (*pCVar2->set_actor)(meta,actor);
  clear_framebuffer_data(&pGVar1->actor_fb);
  clear_framebuffer_data(&pGVar1->background_fb);
  clear_framebuffer_data(&pGVar1->brightness_fb);
  clear_framebuffer_data(&pGVar1->mask_fb);
  pCVar3 = (ClutterActor *)clutter_actor_meta_get_actor(meta);
  pGVar1->actor = pCVar3;
  return;
}



// WARNING: Enum "AtkRole": Some values do not have unique names

void update_actor_box(GbBlurEffect *self,ClutterPaintContext *paint_context,
                     ClutterActorBox *source_actor_box)

{
  long lVar1;
  long in_FS_OFFSET;
  ClutterActorBox *source_actor_box_local;
  ClutterPaintContext *paint_context_local;
  GbBlurEffect *self_local;
  float origin_x;
  float origin_y;
  float width;
  float height;
  float box_scale_factor;
  ClutterStageView *stage_view;
  MtkRectangle stage_view_layout;
  
  lVar1 = *(long *)(in_FS_OFFSET + 0x28);
  box_scale_factor = 1.0;
  if (self->mode == GB_BLUR_MODE_ACTOR) {
    clutter_actor_get_allocation_box(self->actor,source_actor_box);
  }
  else if (self->mode == GB_BLUR_MODE_BACKGROUND) {
    stage_view = (ClutterStageView *)clutter_paint_context_get_stage_view(paint_context);
    clutter_actor_get_transformed_position(self->actor,&origin_x,&origin_y);
    clutter_actor_get_transformed_size(self->actor,&width,&height);
    if (stage_view != (ClutterStageView *)0x0) {
      box_scale_factor = (float)clutter_stage_view_get_scale(stage_view);
      clutter_stage_view_get_layout(stage_view,&stage_view_layout);
      origin_x = origin_x - (float)stage_view_layout.x;
      origin_y = origin_y - (float)stage_view_layout.y;
    }
    clutter_actor_box_set_origin(origin_x,source_actor_box);
    clutter_actor_box_set_size(width,source_actor_box);
    clutter_actor_box_scale(box_scale_factor,source_actor_box);
  }
  clutter_actor_box_clamp_to_pixel(source_actor_box);
  if (lVar1 == *(long *)(in_FS_OFFSET + 0x28)) {
    return;
  }
                    // WARNING: Subroutine does not return
  __stack_chk_fail();
}



// WARNING: Enum "AtkRole": Some values do not have unique names

void add_blurred_pipeline(GbBlurEffect *self,ClutterPaintNode *node,uint8_t paint_opacity)

{
  long in_FS_OFFSET;
  uint8_t paint_opacity_local;
  ClutterPaintNode *node_local;
  GbBlurEffect *self_local;
  float width;
  float height;
  ClutterPaintNode_autoptr pipeline_node;
  undefined4 local_28;
  undefined4 local_24;
  float local_20;
  float local_1c;
  long local_10;
  
  local_10 = *(long *)(in_FS_OFFSET + 0x28);
  pipeline_node = (ClutterPaintNode_autoptr)0x0;
  clutter_actor_get_size(self->actor,&width,&height);
  update_brightness(self,paint_opacity);
  update_mask_uniforms(self,width,height);
  pipeline_node = (ClutterPaintNode_autoptr)clutter_pipeline_node_new((self->mask_fb).pipeline);
  clutter_paint_node_set_static_name(pipeline_node,"GbBlurEffect (final)");
  clutter_paint_node_add_child(node,pipeline_node);
  local_28 = 0;
  local_24 = 0;
  local_20 = width;
  local_1c = height;
  clutter_paint_node_add_rectangle(pipeline_node,&local_28);
  glib_autoptr_cleanup_ClutterPaintNode(&pipeline_node);
  if (local_10 != *(long *)(in_FS_OFFSET + 0x28)) {
                    // WARNING: Subroutine does not return
    __stack_chk_fail();
  }
  return;
}



// WARNING: Removing unreachable block (ram,0x00105187)
// WARNING: Removing unreachable block (ram,0x0010503e)
// WARNING: Removing unreachable block (ram,0x00105081)
// WARNING: Removing unreachable block (ram,0x001051ca)
// WARNING: Enum "AtkRole": Some values do not have unique names

ClutterPaintNode *
create_blur_nodes(GbBlurEffect *self,ClutterPaintNode *node,uint8_t paint_opacity)

{
  uint uVar1;
  ClutterPaintNode *pCVar2;
  long in_FS_OFFSET;
  uint8_t paint_opacity_local;
  ClutterPaintNode *node_local;
  GbBlurEffect *self_local;
  float width;
  float height;
  ClutterPaintNode_autoptr brightness_node;
  ClutterPaintNode_autoptr blur_node;
  ClutterPaintNode_autoptr mask_node;
  undefined4 local_58;
  undefined4 local_54;
  float local_50;
  float local_4c;
  undefined4 local_48;
  undefined4 local_44;
  float local_40;
  float local_3c;
  undefined4 local_38;
  undefined4 local_34;
  float local_30;
  float local_2c;
  long local_20;
  
  local_20 = *(long *)(in_FS_OFFSET + 0x28);
  brightness_node = (ClutterPaintNode_autoptr)0x0;
  blur_node = (ClutterPaintNode_autoptr)0x0;
  mask_node = (ClutterPaintNode_autoptr)0x0;
  clutter_actor_get_size(self->actor,&width,&height);
  update_mask_uniforms(self,width,height);
  mask_node = (ClutterPaintNode_autoptr)
              clutter_layer_node_new_to_framebuffer
                        ((self->mask_fb).framebuffer,(self->mask_fb).pipeline);
  clutter_paint_node_set_static_name(mask_node,"ShellBlurEffect (mask)");
  clutter_paint_node_add_child(node,mask_node);
  local_58 = 0;
  local_54 = 0;
  local_50 = width;
  local_4c = height;
  clutter_paint_node_add_rectangle(mask_node,&local_58);
  update_brightness(self,paint_opacity);
  brightness_node =
       (ClutterPaintNode_autoptr)
       clutter_layer_node_new_to_framebuffer
                 ((self->brightness_fb).framebuffer,(self->brightness_fb).pipeline);
  clutter_paint_node_set_static_name(brightness_node,"ShellBlurEffect (brightness)");
  clutter_paint_node_add_child(mask_node,brightness_node);
  local_48 = 0;
  local_44 = 0;
  uVar1 = cogl_texture_get_width((self->mask_fb).texture);
  local_40 = (float)uVar1;
  uVar1 = cogl_texture_get_height((self->mask_fb).texture);
  local_3c = (float)uVar1;
  clutter_paint_node_add_rectangle(brightness_node,&local_48);
  blur_node = (ClutterPaintNode_autoptr)
              clutter_blur_node_new
                        ((float)self->radius / self->downscale_factor,
                         (long)(self->tex_width / self->downscale_factor) & 0xffffffff,
                         (long)(self->tex_height / self->downscale_factor) & 0xffffffff);
  clutter_paint_node_set_static_name(blur_node,"ShellBlurEffect (blur)");
  clutter_paint_node_add_child(brightness_node,blur_node);
  local_38 = 0;
  local_34 = 0;
  uVar1 = cogl_texture_get_width((self->mask_fb).texture);
  local_30 = (float)uVar1;
  uVar1 = cogl_texture_get_height((self->mask_fb).texture);
  local_2c = (float)uVar1;
  clutter_paint_node_add_rectangle(blur_node,&local_38);
  self->cache_flags = self->cache_flags | BLUR_APPLIED;
  pCVar2 = g_steal_pointer(&blur_node);
  glib_autoptr_cleanup_ClutterPaintNode(&mask_node);
  glib_autoptr_cleanup_ClutterPaintNode(&blur_node);
  glib_autoptr_cleanup_ClutterPaintNode(&brightness_node);
  if (local_20 == *(long *)(in_FS_OFFSET + 0x28)) {
    return pCVar2;
  }
                    // WARNING: Subroutine does not return
  __stack_chk_fail();
}



// WARNING: Enum "AtkRole": Some values do not have unique names

void paint_background(GbBlurEffect *self,ClutterPaintNode *node,ClutterPaintContext *paint_context,
                     ClutterActorBox *source_actor_box)

{
  undefined8 uVar1;
  long in_FS_OFFSET;
  ClutterActorBox *source_actor_box_local;
  ClutterPaintContext *paint_context_local;
  ClutterPaintNode *node_local;
  GbBlurEffect *self_local;
  float transformed_x;
  float transformed_y;
  float transformed_width;
  float transformed_height;
  ClutterPaintNode_autoptr background_node;
  ClutterPaintNode_autoptr blit_node;
  CoglFramebuffer *src;
  undefined4 local_48;
  undefined4 local_44;
  float local_40;
  float local_3c;
  long local_30;
  
  local_30 = *(long *)(in_FS_OFFSET + 0x28);
  background_node = (ClutterPaintNode_autoptr)0x0;
  blit_node = (ClutterPaintNode_autoptr)0x0;
  clutter_actor_box_get_origin(source_actor_box,&transformed_x,&transformed_y);
  clutter_actor_box_get_size(source_actor_box,&transformed_width,&transformed_height);
  background_node =
       (ClutterPaintNode_autoptr)
       clutter_layer_node_new_to_framebuffer
                 ((self->background_fb).framebuffer,(self->background_fb).pipeline);
  clutter_paint_node_set_static_name(background_node,"GbBlurEffect (background)");
  clutter_paint_node_add_child(node,background_node);
  local_48 = 0;
  local_44 = 0;
  local_40 = self->tex_width / self->downscale_factor;
  local_3c = self->tex_height / self->downscale_factor;
  clutter_paint_node_add_rectangle(background_node,&local_48);
  src = (CoglFramebuffer *)clutter_paint_context_get_framebuffer(paint_context);
  blit_node = (ClutterPaintNode_autoptr)clutter_blit_node_new(src);
  clutter_paint_node_set_static_name(blit_node,"GbBlurEffect (blit)");
  clutter_paint_node_add_child(background_node,blit_node);
  uVar1 = clutter_blit_node_get_type();
  uVar1 = g_type_check_instance_cast(blit_node,uVar1);
  clutter_blit_node_add_blit_rectangle
            (uVar1,(int)transformed_x,(int)transformed_y,0,0,(int)transformed_width,
             (int)transformed_height);
  glib_autoptr_cleanup_ClutterPaintNode(&blit_node);
  glib_autoptr_cleanup_ClutterPaintNode(&background_node);
  if (local_30 != *(long *)(in_FS_OFFSET + 0x28)) {
                    // WARNING: Subroutine does not return
    __stack_chk_fail();
  }
  return;
}



// WARNING: Enum "AtkRole": Some values do not have unique names

gboolean update_framebuffers(GbBlurEffect *self,ClutterActorBox *source_actor_box)

{
  gboolean gVar1;
  long in_FS_OFFSET;
  ClutterActorBox *source_actor_box_local;
  GbBlurEffect *self_local;
  float height;
  float width;
  gboolean updated;
  float downscale_factor;
  long local_10;
  
  local_10 = *(long *)(in_FS_OFFSET + 0x28);
  updated = 0;
  height = -1.0;
  width = -1.0;
  clutter_actor_box_get_size(source_actor_box,&width,&height);
  gVar1 = is_valid_dimension(width);
  if ((gVar1 == 0) || (gVar1 = is_valid_dimension(height), gVar1 == 0)) {
    gVar1 = 0;
  }
  else {
    downscale_factor = calculate_downscale_factor(width,height,(float)self->radius);
    gVar1 = update_actor_fbo(self,width,height,downscale_factor);
    if ((gVar1 == 0) ||
       ((gVar1 = update_brightness_fbo(self,width,height,downscale_factor), gVar1 == 0 ||
        (gVar1 = update_mask_fbo(self,width,height,downscale_factor), gVar1 == 0)))) {
      updated = 0;
    }
    else {
      updated = 1;
    }
    if (self->mode == GB_BLUR_MODE_BACKGROUND) {
      if ((updated == 0) || (gVar1 = update_background_fbo(self,width,height), gVar1 == 0)) {
        updated = 0;
      }
      else {
        updated = 1;
      }
    }
    gVar1 = updated;
    if (updated != 0) {
      self->tex_width = width;
      self->tex_height = height;
      self->downscale_factor = downscale_factor;
    }
  }
  if (local_10 == *(long *)(in_FS_OFFSET + 0x28)) {
    return gVar1;
  }
                    // WARNING: Subroutine does not return
  __stack_chk_fail();
}



// WARNING: Enum "AtkRole": Some values do not have unique names

void add_actor_node(GbBlurEffect *self,ClutterPaintNode *node,int opacity)

{
  long in_FS_OFFSET;
  int opacity_local;
  ClutterPaintNode *node_local;
  GbBlurEffect *self_local;
  ClutterPaintNode_autoptr actor_node;
  long local_10;
  
  local_10 = *(long *)(in_FS_OFFSET + 0x28);
  actor_node = (ClutterPaintNode_autoptr)0x0;
  actor_node = (ClutterPaintNode_autoptr)clutter_actor_node_new(self->actor,opacity);
  clutter_paint_node_add_child(node,actor_node);
  glib_autoptr_cleanup_ClutterPaintNode(&actor_node);
  if (local_10 != *(long *)(in_FS_OFFSET + 0x28)) {
                    // WARNING: Subroutine does not return
    __stack_chk_fail();
  }
  return;
}



// WARNING: Enum "AtkRole": Some values do not have unique names

void paint_actor_offscreen(GbBlurEffect *self,ClutterPaintNode *node,ClutterEffectPaintFlags flags)

{
  long lVar1;
  long in_FS_OFFSET;
  ClutterEffectPaintFlags flags_local;
  ClutterPaintNode *node_local;
  GbBlurEffect *self_local;
  gboolean actor_dirty;
  ClutterPaintNode_autoptr transform_node;
  ClutterPaintNode_autoptr layer_node;
  ClutterPaintNode_autoptr pipeline_node;
  float local_60;
  float local_5c;
  graphene_matrix_t transform;
  
  lVar1 = *(long *)(in_FS_OFFSET + 0x28);
  if (((flags & CLUTTER_EFFECT_PAINT_ACTOR_DIRTY) == 0) &&
     ((self->cache_flags & ACTOR_PAINTED) != 0)) {
    pipeline_node = (ClutterPaintNode_autoptr)0x0;
    pipeline_node = (ClutterPaintNode_autoptr)clutter_pipeline_node_new((self->actor_fb).pipeline);
    clutter_paint_node_set_static_name(pipeline_node,"GbBlurEffect (actor texture)");
    clutter_paint_node_add_child(node,pipeline_node);
    transform.__graphene_private_value.x[0] = 0.0;
    transform.__graphene_private_value.x[1] = 0.0;
    transform.__graphene_private_value.x[2] = self->tex_width / self->downscale_factor;
    transform.__graphene_private_value.x[3] = self->tex_height / self->downscale_factor;
    clutter_paint_node_add_rectangle(pipeline_node,&transform);
    glib_autoptr_cleanup_ClutterPaintNode(&pipeline_node);
  }
  else {
    transform_node = (ClutterPaintNode_autoptr)0x0;
    layer_node = (ClutterPaintNode_autoptr)0x0;
    layer_node = (ClutterPaintNode_autoptr)
                 clutter_layer_node_new_to_framebuffer
                           ((self->actor_fb).framebuffer,(self->actor_fb).pipeline);
    clutter_paint_node_set_static_name(layer_node,"GbBlurEffect (actor offscreen)");
    clutter_paint_node_add_child(node,layer_node);
    pipeline_node = (ClutterPaintNode_autoptr)0x0;
    local_60 = self->tex_width / self->downscale_factor;
    local_5c = self->tex_height / self->downscale_factor;
    clutter_paint_node_add_rectangle(layer_node,&pipeline_node);
    graphene_matrix_init_scale
              (1.0 / self->downscale_factor,1.0 / self->downscale_factor,0x3f800000,&transform);
    transform_node = (ClutterPaintNode_autoptr)clutter_transform_node_new(&transform);
    clutter_paint_node_set_static_name(transform_node,"GbBlurEffect (downscale)");
    clutter_paint_node_add_child(layer_node,transform_node);
    add_actor_node(self,transform_node,0xff);
    self->cache_flags = self->cache_flags | ACTOR_PAINTED;
    glib_autoptr_cleanup_ClutterPaintNode(&layer_node);
    glib_autoptr_cleanup_ClutterPaintNode(&transform_node);
  }
  if (lVar1 != *(long *)(in_FS_OFFSET + 0x28)) {
                    // WARNING: Subroutine does not return
    __stack_chk_fail();
  }
  return;
}



// WARNING: Enum "AtkRole": Some values do not have unique names

gboolean needs_repaint(GbBlurEffect *self,ClutterEffectPaintFlags flags)

{
  gboolean gVar1;
  ClutterEffectPaintFlags flags_local;
  GbBlurEffect *self_local;
  gboolean actor_dirty;
  gboolean blur_cached;
  gboolean actor_cached;
  
  if (self->mode == GB_BLUR_MODE_ACTOR) {
    if ((((flags & CLUTTER_EFFECT_PAINT_ACTOR_DIRTY) == 0) &&
        ((self->cache_flags & BLUR_APPLIED) != 0)) && ((self->cache_flags & ACTOR_PAINTED) != 0)) {
      gVar1 = 0;
    }
    else {
      gVar1 = 1;
    }
  }
  else if (self->mode == GB_BLUR_MODE_BACKGROUND) {
    gVar1 = 1;
  }
  else {
    gVar1 = 1;
  }
  return gVar1;
}



// WARNING: Enum "AtkRole": Some values do not have unique names

void gb_blur_effect_paint_node
               (ClutterEffect *effect,ClutterPaintNode *node,ClutterPaintContext *paint_context,
               ClutterEffectPaintFlags flags)

{
  long lVar1;
  bool bVar2;
  gboolean gVar3;
  long in_FS_OFFSET;
  ClutterEffectPaintFlags flags_local;
  ClutterPaintContext *paint_context_local;
  ClutterPaintNode *node_local;
  ClutterEffect *effect_local;
  uint8_t paint_opacity;
  ClutterPaintNode_autoptr blur_node;
  GbBlurEffect *self;
  ClutterActorBox source_actor_box;
  
  lVar1 = *(long *)(in_FS_OFFSET + 0x28);
  self = GB_BLUR_EFFECT(effect);
  if (self->actor == (ClutterActor *)0x0) goto LAB_00105bdd;
  if (0 < self->radius) {
    blur_node = (ClutterPaintNode_autoptr)0x0;
    if (self->mode == GB_BLUR_MODE_ACTOR) {
      paint_opacity = clutter_actor_get_paint_opacity(self->actor);
LAB_00105ab2:
      gVar3 = needs_repaint(self,flags);
      if (gVar3 == 0) {
        add_blurred_pipeline(self,node,paint_opacity);
      }
      else {
        update_actor_box(self,paint_context,&source_actor_box);
        gVar3 = update_framebuffers(self,&source_actor_box);
        if (gVar3 == 0) {
          bVar2 = false;
          goto LAB_00105baf;
        }
        blur_node = create_blur_nodes(self,node,paint_opacity);
        if (self->mode == GB_BLUR_MODE_ACTOR) {
          paint_actor_offscreen(self,blur_node,flags);
        }
        else if (self->mode == GB_BLUR_MODE_BACKGROUND) {
          paint_background(self,blur_node,paint_context,&source_actor_box);
        }
      }
      if ((self->mode != GB_BLUR_MODE_ACTOR) && (self->mode == GB_BLUR_MODE_BACKGROUND)) {
        add_actor_node(self,node,-1);
      }
      bVar2 = true;
    }
    else {
      if (self->mode == GB_BLUR_MODE_BACKGROUND) {
        paint_opacity = 0xff;
        goto LAB_00105ab2;
      }
      bVar2 = false;
    }
LAB_00105baf:
    glib_autoptr_cleanup_ClutterPaintNode(&blur_node);
    if (bVar2) goto LAB_00105bdd;
  }
  add_actor_node(self,node,-1);
LAB_00105bdd:
  if (lVar1 == *(long *)(in_FS_OFFSET + 0x28)) {
    return;
  }
                    // WARNING: Subroutine does not return
  __stack_chk_fail();
}



// WARNING: Enum "AtkRole": Some values do not have unique names

void gb_blur_effect_finalize(GObject *object)

{
  GTypeClass *pGVar1;
  GData *pGVar2;
  long lVar3;
  GObject *object_local;
  GbBlurEffect *self;
  CoglPipeline **_pp;
  CoglPipeline *_ptr;
  CoglPipeline **_pp_1;
  CoglPipeline *_ptr_1;
  CoglPipeline **_pp_2;
  CoglPipeline *_ptr_2;
  CoglPipeline **_pp_3;
  CoglPipeline *_ptr_3;
  
  clear_framebuffer_data((FramebufferData *)&object[1].qdata);
  clear_framebuffer_data((FramebufferData *)(object + 3));
  clear_framebuffer_data((FramebufferData *)(object + 4));
  clear_framebuffer_data((FramebufferData *)&object[5].ref_count);
  pGVar1 = object[2].g_type_instance.g_class;
  object[2].g_type_instance.g_class = (GTypeClass *)0x0;
  if (pGVar1 != (GTypeClass *)0x0) {
    g_object_unref(pGVar1);
  }
  lVar3 = *(long *)&object[3].ref_count;
  *(undefined8 *)&object[3].ref_count = 0;
  if (lVar3 != 0) {
    g_object_unref(lVar3);
  }
  lVar3 = *(long *)&object[4].ref_count;
  *(undefined8 *)&object[4].ref_count = 0;
  if (lVar3 != 0) {
    g_object_unref(lVar3);
  }
  pGVar2 = object[5].qdata;
  object[5].qdata = (GData *)0x0;
  if (pGVar2 != (GData *)0x0) {
    g_object_unref(pGVar2);
  }
  lVar3 = g_type_check_class_cast(gb_blur_effect_parent_class,0x50);
  (**(code **)(lVar3 + 0x30))(object);
  return;
}



// WARNING: Enum "AtkRole": Some values do not have unique names
// WARNING: Enum "GParamFlags": Some values do not have unique names

void gb_blur_effect_get_property(GObject *object,guint prop_id,GValue *value,GParamSpec *pspec)

{
  GbBlurEffect *pGVar1;
  undefined8 uVar2;
  undefined8 uVar3;
  GParamSpec *pspec_local;
  GValue *value_local;
  guint prop_id_local;
  GObject *object_local;
  guint _glib__property_id;
  GbBlurEffect *self;
  GObject *_glib__object;
  GParamSpec *_glib__pspec;
  
  pGVar1 = GB_BLUR_EFFECT(object);
  if (prop_id == 4) {
    g_value_set_float(pGVar1->corner_radius,value);
    return;
  }
  if (prop_id < 5) {
    if (prop_id == 3) {
      g_value_set_enum(value,pGVar1->mode);
      return;
    }
    if (prop_id < 4) {
      if (prop_id == 1) {
        g_value_set_int(value,pGVar1->radius);
        return;
      }
      if (prop_id == 2) {
        g_value_set_float(pGVar1->brightness,value);
        return;
      }
    }
  }
  uVar2 = g_type_name(((object->g_type_instance).g_class)->g_type);
  uVar3 = g_type_name(((pspec->g_type_instance).g_class)->g_type);
  g_log(0,0x10,"%s:%d: invalid %s id %u for \"%s\" of type \'%s\' in \'%s\'",
        "../src/rounded-blur-effect.c",0x367,"property",prop_id,pspec->name,uVar3,uVar2);
  return;
}



// WARNING: Enum "GParamFlags": Some values do not have unique names
// WARNING: Enum "AtkRole": Some values do not have unique names

void gb_blur_effect_set_property(GObject *object,guint prop_id,GValue *value,GParamSpec *pspec)

{
  int radius;
  GbBlurMode mode;
  GbBlurEffect *self_00;
  undefined8 uVar1;
  undefined8 uVar2;
  float fVar3;
  GParamSpec *pspec_local;
  GValue *value_local;
  guint prop_id_local;
  GObject *object_local;
  guint _glib__property_id;
  GbBlurEffect *self;
  GObject *_glib__object;
  GParamSpec *_glib__pspec;
  
  self_00 = GB_BLUR_EFFECT(object);
  if (prop_id == 4) {
    fVar3 = (float)g_value_get_float(value);
    gb_blur_effect_set_corner_radius(self_00,fVar3);
    return;
  }
  if (prop_id < 5) {
    if (prop_id == 3) {
      mode = g_value_get_enum(value);
      gb_blur_effect_set_mode(self_00,mode);
      return;
    }
    if (prop_id < 4) {
      if (prop_id == 1) {
        radius = g_value_get_int(value);
        gb_blur_effect_set_radius(self_00,radius);
        return;
      }
      if (prop_id == 2) {
        fVar3 = (float)g_value_get_float(value);
        gb_blur_effect_set_brightness(self_00,fVar3);
        return;
      }
    }
  }
  uVar1 = g_type_name(((object->g_type_instance).g_class)->g_type);
  uVar2 = g_type_name(((pspec->g_type_instance).g_class)->g_type);
  g_log(0,0x10,"%s:%d: invalid %s id %u for \"%s\" of type \'%s\' in \'%s\'",
        "../src/rounded-blur-effect.c",0x386,"property",prop_id,pspec->name,uVar2,uVar1);
  return;
}



// WARNING: Enum "GParamFlags": Some values do not have unique names
// WARNING: Enum "AtkRole": Some values do not have unique names

void gb_blur_effect_class_init(GbBlurEffectClass *klass)

{
  long lVar1;
  ClutterActorMetaClass *pCVar2;
  ClutterEffectClass *pCVar3;
  GType GVar4;
  GbBlurEffectClass *klass_local;
  GObjectClass *object_class;
  ClutterActorMetaClass *meta_class;
  ClutterEffectClass *effect_class;
  
  lVar1 = g_type_check_class_cast(klass,0x50);
  pCVar2 = CLUTTER_ACTOR_META_CLASS(klass);
  pCVar3 = CLUTTER_EFFECT_CLASS(klass);
  *(code **)(lVar1 + 0x30) = gb_blur_effect_finalize;
  *(code **)(lVar1 + 0x20) = gb_blur_effect_get_property;
  *(code **)(lVar1 + 0x18) = gb_blur_effect_set_property;
  pCVar2->set_actor = gb_blur_effect_set_actor;
  pCVar3->paint_node = gb_blur_effect_paint_node;
  properties[1] = (GParamSpec *)g_param_spec_int("radius",0,0,0,0x7fffffff,0,0x400000e3);
  properties[2] = (GParamSpec *)g_param_spec_float(0,0x3f800000,"brightness",0,0,0x400000e3);
  GVar4 = gb_blur_mode_get_type();
  properties[3] = (GParamSpec *)g_param_spec_enum(&DAT_0010a500,0,0,GVar4,0,0x400000e3);
  properties[4] = (GParamSpec *)g_param_spec_float(0,0x7f7fffff,0,"corner-radius",0,0,0x400000e3);
  g_object_class_install_properties(lVar1,5,properties);
  return;
}



// WARNING: Enum "AtkRole": Some values do not have unique names

void gb_blur_effect_init(GbBlurEffect *self)

{
  int iVar1;
  CoglPipeline *pCVar2;
  GbBlurEffect *self_local;
  
  self->mode = GB_BLUR_MODE_ACTOR;
  self->radius = 0;
  self->brightness = 1.0;
  self->corner_radius = 0.0;
  pCVar2 = create_base_pipeline();
  (self->actor_fb).pipeline = pCVar2;
  pCVar2 = create_base_pipeline();
  (self->background_fb).pipeline = pCVar2;
  pCVar2 = create_brightness_pipeline();
  (self->brightness_fb).pipeline = pCVar2;
  pCVar2 = create_mask_pipeline();
  (self->mask_fb).pipeline = pCVar2;
  iVar1 = cogl_pipeline_get_uniform_location((self->brightness_fb).pipeline,"brightness");
  self->brightness_uniform = iVar1;
  iVar1 = cogl_pipeline_get_uniform_location((self->mask_fb).pipeline,"u_corner_radius");
  self->corner_radius_uniform = iVar1;
  iVar1 = cogl_pipeline_get_uniform_location((self->mask_fb).pipeline,"u_size");
  self->mask_size_uniform = iVar1;
  return;
}



// WARNING: Unknown calling convention -- yet parameter storage is locked
// WARNING: Enum "AtkRole": Some values do not have unique names

GbBlurEffect * gb_blur_effect_new(void)

{
  GType GVar1;
  GbBlurEffect *pGVar2;
  
  GVar1 = gb_blur_effect_get_type();
  pGVar2 = (GbBlurEffect *)g_object_new(GVar1,0);
  return pGVar2;
}



// WARNING: Enum "AtkRole": Some values do not have unique names

int gb_blur_effect_get_radius(GbBlurEffect *self)

{
  gboolean gVar1;
  int iVar2;
  GbBlurEffect *self_local;
  
  gVar1 = GB_IS_BLUR_EFFECT(self);
  if (gVar1 == 0) {
    g_return_if_fail_warning(0,"gb_blur_effect_get_radius","GB_IS_BLUR_EFFECT (self)");
    iVar2 = 0;
  }
  else {
    iVar2 = self->radius;
  }
  return iVar2;
}



// WARNING: Enum "AtkRole": Some values do not have unique names
// WARNING: Enum "GParamFlags": Some values do not have unique names

void gb_blur_effect_set_radius(GbBlurEffect *self,int radius)

{
  GParamSpec *pGVar1;
  gboolean gVar2;
  ClutterEffect *pCVar3;
  undefined8 uVar4;
  int radius_local;
  GbBlurEffect *self_local;
  
  gVar2 = GB_IS_BLUR_EFFECT(self);
  if (gVar2 == 0) {
    g_return_if_fail_warning(0,"gb_blur_effect_set_radius","GB_IS_BLUR_EFFECT (self)");
  }
  else {
    if (radius < 0) {
      radius = 0;
    }
    if (radius != self->radius) {
      self->radius = radius;
      self->cache_flags = self->cache_flags & ~BLUR_APPLIED;
      if (self->actor != (ClutterActor *)0x0) {
        pCVar3 = CLUTTER_EFFECT(self);
        clutter_effect_queue_repaint(pCVar3);
      }
      pGVar1 = properties[1];
      uVar4 = g_type_check_instance_cast(self,0x50);
      g_object_notify_by_pspec(uVar4,pGVar1);
    }
  }
  return;
}



// WARNING: Enum "AtkRole": Some values do not have unique names

float gb_blur_effect_get_brightness(GbBlurEffect *self)

{
  gboolean gVar1;
  float fVar2;
  GbBlurEffect *self_local;
  
  gVar1 = GB_IS_BLUR_EFFECT(self);
  if (gVar1 == 0) {
    g_return_if_fail_warning(0,"gb_blur_effect_get_brightness","GB_IS_BLUR_EFFECT (self)");
    fVar2 = -1.0;
  }
  else {
    fVar2 = self->brightness;
  }
  return fVar2;
}



// WARNING: Enum "AtkRole": Some values do not have unique names
// WARNING: Enum "GParamFlags": Some values do not have unique names

void gb_blur_effect_set_brightness(GbBlurEffect *self,float brightness)

{
  GParamSpec *pGVar1;
  gboolean gVar2;
  ClutterEffect *pCVar3;
  undefined8 uVar4;
  float fVar5;
  float brightness_local;
  GbBlurEffect *self_local;
  
  gVar2 = GB_IS_BLUR_EFFECT(self);
  if (gVar2 == 0) {
    g_return_if_fail_warning(0,"gb_blur_effect_set_brightness","GB_IS_BLUR_EFFECT (self)");
  }
  else {
    fVar5 = sanitize_float_property(brightness,0.0,1.0,1.0);
    if (self->brightness != fVar5) {
      self->brightness = fVar5;
      self->cache_flags = self->cache_flags & ~BLUR_APPLIED;
      if (self->actor != (ClutterActor *)0x0) {
        pCVar3 = CLUTTER_EFFECT(self);
        clutter_effect_queue_repaint(pCVar3);
      }
      pGVar1 = properties[2];
      uVar4 = g_type_check_instance_cast(self,0x50);
      g_object_notify_by_pspec(uVar4,pGVar1);
    }
  }
  return;
}



// WARNING: Enum "AtkRole": Some values do not have unique names

GbBlurMode gb_blur_effect_get_mode(GbBlurEffect *self)

{
  gboolean gVar1;
  GbBlurMode GVar2;
  GbBlurEffect *self_local;
  
  gVar1 = GB_IS_BLUR_EFFECT(self);
  if (gVar1 == 0) {
    g_return_if_fail_warning(0,"gb_blur_effect_get_mode","GB_IS_BLUR_EFFECT (self)");
    GVar2 = GB_BLUR_MODE_ACTOR;
  }
  else {
    GVar2 = self->mode;
  }
  return GVar2;
}



// WARNING: Enum "AtkRole": Some values do not have unique names
// WARNING: Enum "GParamFlags": Some values do not have unique names

void gb_blur_effect_set_mode(GbBlurEffect *self,GbBlurMode mode)

{
  GParamSpec *pGVar1;
  gboolean gVar2;
  ClutterEffect *pCVar3;
  undefined8 uVar4;
  GbBlurMode mode_local;
  GbBlurEffect *self_local;
  
  gVar2 = GB_IS_BLUR_EFFECT(self);
  if (gVar2 == 0) {
    g_return_if_fail_warning(0,"gb_blur_effect_set_mode","GB_IS_BLUR_EFFECT (self)");
  }
  else {
    gVar2 = is_valid_mode(mode);
    mode_local = mode;
    if (gVar2 == 0) {
      mode_local = GB_BLUR_MODE_ACTOR;
    }
    if (mode_local != self->mode) {
      self->mode = mode_local;
      self->cache_flags = self->cache_flags & ~BLUR_APPLIED;
      if (mode_local == GB_BLUR_MODE_ACTOR) {
        clear_framebuffer_data(&self->background_fb);
      }
      if (self->actor != (ClutterActor *)0x0) {
        pCVar3 = CLUTTER_EFFECT(self);
        clutter_effect_queue_repaint(pCVar3);
      }
      pGVar1 = properties[3];
      uVar4 = g_type_check_instance_cast(self,0x50);
      g_object_notify_by_pspec(uVar4,pGVar1);
    }
  }
  return;
}



// WARNING: Enum "AtkRole": Some values do not have unique names

float gb_blur_effect_get_corner_radius(GbBlurEffect *self)

{
  gboolean gVar1;
  float fVar2;
  GbBlurEffect *self_local;
  
  gVar1 = GB_IS_BLUR_EFFECT(self);
  if (gVar1 == 0) {
    g_return_if_fail_warning(0,"gb_blur_effect_get_corner_radius","GB_IS_BLUR_EFFECT (self)");
    fVar2 = 0.0;
  }
  else {
    fVar2 = self->corner_radius;
  }
  return fVar2;
}



// WARNING: Enum "AtkRole": Some values do not have unique names
// WARNING: Enum "GParamFlags": Some values do not have unique names

void gb_blur_effect_set_corner_radius(GbBlurEffect *self,float corner_radius)

{
  GParamSpec *pGVar1;
  gboolean gVar2;
  ClutterEffect *pCVar3;
  undefined8 uVar4;
  float fVar5;
  float corner_radius_local;
  GbBlurEffect *self_local;
  
  gVar2 = GB_IS_BLUR_EFFECT(self);
  if (gVar2 == 0) {
    g_return_if_fail_warning(0,"gb_blur_effect_set_corner_radius","GB_IS_BLUR_EFFECT (self)");
  }
  else {
    fVar5 = sanitize_float_property(corner_radius,0.0,3.4028235e+38,0.0);
    if (self->corner_radius != fVar5) {
      self->corner_radius = fVar5;
      self->cache_flags = self->cache_flags & ~BLUR_APPLIED;
      if (self->actor != (ClutterActor *)0x0) {
        pCVar3 = CLUTTER_EFFECT(self);
        clutter_effect_queue_repaint(pCVar3);
      }
      pGVar1 = properties[4];
      uVar4 = g_type_check_instance_cast(self,0x50);
      g_object_notify_by_pspec(uVar4,pGVar1);
    }
  }
  return;
}



gpointer g_steal_pointer(gpointer pp)

{
  gpointer pvVar1;
  gpointer pp_local;
  gpointer *ptr;
  gpointer ref;
  
  pvVar1 = *(gpointer *)pp;
  *(undefined8 *)pp = 0;
  return pvVar1;
}



CoglFramebuffer * COGL_FRAMEBUFFER(gpointer ptr)

{
  undefined8 uVar1;
  CoglFramebuffer *pCVar2;
  gpointer ptr_local;
  
  uVar1 = cogl_framebuffer_get_type();
  pCVar2 = (CoglFramebuffer *)g_type_check_instance_cast(ptr,uVar1);
  return pCVar2;
}



// WARNING: Enum "GParamFlags": Some values do not have unique names
// WARNING: Enum "AtkRole": Some values do not have unique names

ClutterActorMetaClass * CLUTTER_ACTOR_META_CLASS(gpointer ptr)

{
  undefined8 uVar1;
  ClutterActorMetaClass *pCVar2;
  gpointer ptr_local;
  
  uVar1 = clutter_actor_meta_get_type();
  pCVar2 = (ClutterActorMetaClass *)g_type_check_class_cast(ptr,uVar1);
  return pCVar2;
}



ClutterEffect * CLUTTER_EFFECT(gpointer ptr)

{
  undefined8 uVar1;
  ClutterEffect *pCVar2;
  gpointer ptr_local;
  
  uVar1 = clutter_effect_get_type();
  pCVar2 = (ClutterEffect *)g_type_check_instance_cast(ptr,uVar1);
  return pCVar2;
}



// WARNING: Enum "GParamFlags": Some values do not have unique names
// WARNING: Enum "AtkRole": Some values do not have unique names

ClutterEffectClass * CLUTTER_EFFECT_CLASS(gpointer ptr)

{
  undefined8 uVar1;
  ClutterEffectClass *pCVar2;
  gpointer ptr_local;
  
  uVar1 = clutter_effect_get_type();
  pCVar2 = (ClutterEffectClass *)g_type_check_class_cast(ptr,uVar1);
  return pCVar2;
}



void glib_autoptr_clear_ClutterPaintNode(ClutterPaintNode *_ptr)

{
  ClutterPaintNode *_ptr_local;
  
  if (_ptr != (ClutterPaintNode *)0x0) {
    clutter_paint_node_unref(_ptr);
  }
  return;
}



void glib_autoptr_cleanup_ClutterPaintNode(ClutterPaintNode **_ptr)

{
  ClutterPaintNode **_ptr_local;
  
  glib_autoptr_clear_ClutterPaintNode(*_ptr);
  return;
}



// WARNING: Enum "AtkRole": Some values do not have unique names

GbLiquidGlassEffect * GB_LIQUID_GLASS_EFFECT(gpointer ptr)

{
  GType GVar1;
  GbLiquidGlassEffect *pGVar2;
  gpointer ptr_local;
  
  GVar1 = gb_liquid_glass_effect_get_type();
  pGVar2 = (GbLiquidGlassEffect *)g_type_check_instance_cast(ptr,GVar1);
  return pGVar2;
}



gboolean GB_IS_LIQUID_GLASS_EFFECT(gpointer ptr)

{
  GType GVar1;
  gpointer ptr_local;
  gboolean __r;
  GTypeInstance *__inst;
  GType __t;
  
  GVar1 = gb_liquid_glass_effect_get_type();
  if (ptr == (gpointer)0x0) {
    __r = 0;
  }
  else if ((*(long *)ptr == 0) || (GVar1 != **(GType **)ptr)) {
    __r = g_type_check_instance_is_a(ptr,GVar1);
  }
  else {
    __r = 1;
  }
  return __r;
}



// WARNING: Enum "GParamFlags": Some values do not have unique names
// WARNING: Enum "AtkRole": Some values do not have unique names

void gb_liquid_glass_effect_class_intern_init(gpointer klass)

{
  gpointer klass_local;
  
  gb_liquid_glass_effect_parent_class = (gpointer)g_type_class_peek_parent(klass);
  if (GbLiquidGlassEffect_private_offset != 0) {
    g_type_class_adjust_private_offset(klass,&GbLiquidGlassEffect_private_offset);
  }
  gb_liquid_glass_effect_class_init(klass);
  return;
}



// WARNING: Unknown calling convention -- yet parameter storage is locked

GType gb_liquid_glass_effect_get_type(void)

{
  long lVar1;
  bool bVar2;
  int iVar3;
  GType GVar4;
  long in_FS_OFFSET;
  GType gapg_temp_newval;
  GType *gapg_temp_atomic;
  GType g_define_type_id;
  
  lVar1 = *(long *)(in_FS_OFFSET + 0x28);
  if (gb_liquid_glass_effect_get_type::static_g_define_type_id == 0) {
    iVar3 = g_once_init_enter_pointer(&gb_liquid_glass_effect_get_type::static_g_define_type_id);
    if (iVar3 != 0) {
      bVar2 = true;
      goto LAB_001069f4;
    }
  }
  bVar2 = false;
LAB_001069f4:
  if (bVar2) {
    GVar4 = gb_liquid_glass_effect_get_type_once();
    g_once_init_leave_pointer(&gb_liquid_glass_effect_get_type::static_g_define_type_id,GVar4);
  }
  if (lVar1 != *(long *)(in_FS_OFFSET + 0x28)) {
                    // WARNING: Subroutine does not return
    __stack_chk_fail();
  }
  return gb_liquid_glass_effect_get_type::static_g_define_type_id;
}



// WARNING: Unknown calling convention -- yet parameter storage is locked
// WARNING: Enum "AtkRole": Some values do not have unique names

GType gb_liquid_glass_effect_get_type_once(void)

{
  undefined8 uVar1;
  undefined8 uVar2;
  GType GVar3;
  GType g_define_type_id;
  
  uVar1 = g_intern_static_string("GbLiquidGlassEffect");
  uVar2 = clutter_effect_get_type();
  GVar3 = g_type_register_static_simple
                    (uVar2,uVar1,200,gb_liquid_glass_effect_class_intern_init,0xd0,
                     gb_liquid_glass_effect_init,0);
  return GVar3;
}



// WARNING: Unknown calling convention -- yet parameter storage is locked

CoglPipeline * create_base_pipeline(void)

{
  undefined8 uVar1;
  CoglPipeline *pCVar2;
  ClutterBackend *backend;
  CoglContext *ctx;
  
  if (create_base_pipeline::base_pipeline == (CoglPipeline *)0x0) {
    uVar1 = clutter_get_default_backend();
    uVar1 = clutter_backend_get_cogl_context(uVar1);
    create_base_pipeline::base_pipeline = (CoglPipeline *)cogl_pipeline_new(uVar1);
    cogl_pipeline_set_layer_null_texture(create_base_pipeline::base_pipeline,0);
    cogl_pipeline_set_layer_filters(create_base_pipeline::base_pipeline,0,0x2601,0x2601);
    cogl_pipeline_set_layer_wrap_mode(create_base_pipeline::base_pipeline,0,0x812f);
  }
  pCVar2 = (CoglPipeline *)cogl_pipeline_copy(create_base_pipeline::base_pipeline);
  return pCVar2;
}



// WARNING: Unknown calling convention -- yet parameter storage is locked

CoglPipeline * create_brightness_pipeline(void)

{
  undefined8 uVar1;
  CoglPipeline *pCVar2;
  CoglSnippet *snippet;
  
  if (create_brightness_pipeline::brightness_pipeline == (CoglPipeline *)0x0) {
    create_brightness_pipeline::brightness_pipeline = create_base_pipeline();
    uVar1 = cogl_snippet_new(0x800,brightness_glsl_declarations,brightness_glsl);
    cogl_pipeline_add_snippet(create_brightness_pipeline::brightness_pipeline,uVar1);
    g_object_unref(uVar1);
  }
  pCVar2 = (CoglPipeline *)cogl_pipeline_copy(create_brightness_pipeline::brightness_pipeline);
  return pCVar2;
}



// WARNING: Unknown calling convention -- yet parameter storage is locked

CoglPipeline * create_mask_pipeline(void)

{
  undefined8 uVar1;
  CoglPipeline *pCVar2;
  CoglSnippet *fragment_snippet;
  CoglSnippet *lookup_snippet;
  
  if (create_mask_pipeline::mask_pipeline == (CoglPipeline *)0x0) {
    create_mask_pipeline::mask_pipeline = create_base_pipeline();
    uVar1 = cogl_snippet_new(0x801,size_glsl_declarations,0);
    cogl_pipeline_add_snippet(create_mask_pipeline::mask_pipeline,uVar1);
    g_object_unref(uVar1);
    uVar1 = cogl_snippet_new(0x1801,glass_lookup_glsl_declarations,0);
    cogl_snippet_set_pre(uVar1,glass_lookup_glsl);
    cogl_pipeline_add_layer_snippet(create_mask_pipeline::mask_pipeline,0,uVar1);
    g_object_unref(uVar1);
    uVar1 = cogl_snippet_new(0x800,glass_glsl_declarations,glass_glsl);
    cogl_pipeline_add_snippet(create_mask_pipeline::mask_pipeline,uVar1);
    g_object_unref(uVar1);
  }
  pCVar2 = (CoglPipeline *)cogl_pipeline_copy(create_mask_pipeline::mask_pipeline);
  return pCVar2;
}



void clear_framebuffer_data(FramebufferData *fb_data)

{
  CoglFramebuffer *pCVar1;
  CoglTexture *pCVar2;
  FramebufferData *fb_data_local;
  CoglFramebuffer **_pp;
  CoglFramebuffer *_ptr;
  CoglTexture **_pp_1;
  CoglTexture *_ptr_1;
  
  if (fb_data->pipeline != (CoglPipeline *)0x0) {
    cogl_pipeline_set_layer_null_texture(fb_data->pipeline,0);
  }
  pCVar1 = fb_data->framebuffer;
  fb_data->framebuffer = (CoglFramebuffer *)0x0;
  if (pCVar1 != (CoglFramebuffer *)0x0) {
    g_object_unref(pCVar1);
  }
  pCVar2 = fb_data->texture;
  fb_data->texture = (CoglTexture *)0x0;
  if (pCVar2 != (CoglTexture *)0x0) {
    g_object_unref(pCVar2);
  }
  return;
}



gboolean is_valid_dimension(float value)

{
  gboolean gVar1;
  float value_local;
  
  if (((3.4028235e+38 < ABS(value)) || (value < 1.0)) || (4.2949673e+09 < value)) {
    gVar1 = 0;
  }
  else {
    gVar1 = 1;
  }
  return gVar1;
}



float sanitize_float_property(float value,float min,float max,float fallback)

{
  float fallback_local;
  float max_local;
  float min_local;
  float value_local;
  
  if (((ABS(value) <= 3.4028235e+38) && (fallback = max, value <= max)) &&
     (fallback = value, value < min)) {
    fallback = min;
  }
  return fallback;
}



gboolean is_valid_mode(GbBlurMode mode)

{
  gboolean gVar1;
  GbBlurMode mode_local;
  
  if ((mode == GB_BLUR_MODE_ACTOR) || (mode == GB_BLUR_MODE_BACKGROUND)) {
    gVar1 = 1;
  }
  else {
    gVar1 = 0;
  }
  return gVar1;
}



// WARNING: Enum "AtkRole": Some values do not have unique names

void update_brightness(GbLiquidGlassEffect *self,uint8_t paint_opacity)

{
  long lVar1;
  long in_FS_OFFSET;
  undefined1 auVar2 [16];
  undefined1 auVar3 [16];
  uint8_t paint_opacity_local;
  GbLiquidGlassEffect *self_local;
  CoglColor color;
  
  lVar1 = *(long *)(in_FS_OFFSET + 0x28);
  auVar3._4_12_ = SUB1612((undefined1  [16])0x0,4);
  auVar3._0_4_ = (float)paint_opacity / 255.0;
  auVar2._4_12_ = SUB1612((undefined1  [16])0x0,4);
  auVar2._0_4_ = (float)paint_opacity / 255.0;
  cogl_color_init_from_4f
            ((float)paint_opacity / 255.0,(float)paint_opacity / 255.0,auVar2._0_8_,auVar3._0_8_,
             &color);
  cogl_pipeline_set_color((self->brightness_fb).pipeline,&color);
  if (-1 < self->brightness_uniform) {
    cogl_pipeline_set_uniform_1f
              (self->brightness,(self->brightness_fb).pipeline,self->brightness_uniform);
  }
  if (lVar1 != *(long *)(in_FS_OFFSET + 0x28)) {
                    // WARNING: Subroutine does not return
    __stack_chk_fail();
  }
  return;
}



// WARNING: Variable defined which should be unmapped: height_local
// WARNING: Enum "AtkRole": Some values do not have unique names

void update_mask_uniforms(GbLiquidGlassEffect *self,float width,float height)

{
  long lVar1;
  undefined8 in_R9;
  long in_FS_OFFSET;
  float height_local;
  float width_local;
  GbLiquidGlassEffect *self_local;
  float size [2];
  
  lVar1 = *(long *)(in_FS_OFFSET + 0x28);
  if ((self->mask_fb).pipeline != (CoglPipeline *)0x0) {
    if (-1 < self->corner_radius_uniform) {
      cogl_pipeline_set_uniform_1f
                (self->corner_radius,(self->mask_fb).pipeline,self->corner_radius_uniform);
    }
    if (-1 < self->mask_size_uniform) {
      size[0] = width;
      size[1] = height;
      cogl_pipeline_set_uniform_float
                ((self->mask_fb).pipeline,self->mask_size_uniform,2,1,size,in_R9,height);
    }
    if (-1 < self->highlight_uniform) {
      cogl_pipeline_set_uniform_1f(self->highlight,(self->mask_fb).pipeline,self->highlight_uniform)
      ;
    }
    if (-1 < self->refraction_uniform) {
      cogl_pipeline_set_uniform_1f
                (self->refraction,(self->mask_fb).pipeline,self->refraction_uniform);
    }
    if (-1 < self->depth_uniform) {
      cogl_pipeline_set_uniform_1f(self->depth,(self->mask_fb).pipeline,self->depth_uniform);
    }
  }
  if (lVar1 != *(long *)(in_FS_OFFSET + 0x28)) {
                    // WARNING: Subroutine does not return
    __stack_chk_fail();
  }
  return;
}



void setup_projection_matrix(CoglFramebuffer *framebuffer,float width,float height)

{
  long lVar1;
  long in_FS_OFFSET;
  float height_local;
  float width_local;
  CoglFramebuffer *framebuffer_local;
  float local_64;
  float local_60;
  undefined4 local_5c;
  graphene_matrix_t projection;
  
  lVar1 = *(long *)(in_FS_OFFSET + 0x28);
  local_64 = -width / 2.0;
  local_60 = -height / 2.0;
  local_5c = 0;
  graphene_matrix_init_translate(&projection,&local_64);
  graphene_matrix_scale(2.0 / width,-2.0 / height,0x3f800000,&projection);
  cogl_framebuffer_set_projection_matrix(framebuffer,&projection);
  if (lVar1 != *(long *)(in_FS_OFFSET + 0x28)) {
                    // WARNING: Subroutine does not return
    __stack_chk_fail();
  }
  return;
}



gboolean update_fbo(FramebufferData *data,float width,float height,float downscale_factor)

{
  gboolean gVar1;
  long lVar2;
  CoglTexture *pCVar3;
  gpointer ptr;
  CoglFramebuffer *pCVar4;
  float value;
  float value_00;
  float downscale_factor_local;
  float height_local;
  float width_local;
  FramebufferData *data_local;
  float new_width;
  float new_height;
  ClutterBackend *backend;
  CoglContext *ctx;
  
  if ((((data->pipeline == (CoglPipeline *)0x0) || (gVar1 = is_valid_dimension(width), gVar1 == 0))
      || (gVar1 = is_valid_dimension(height), gVar1 == 0)) ||
     ((3.4028235e+38 < ABS(downscale_factor) || (downscale_factor < 1.0)))) {
    return 0;
  }
  value = floorf(width / downscale_factor);
  value_00 = floorf(height / downscale_factor);
  gVar1 = is_valid_dimension(value);
  if ((gVar1 == 0) || (gVar1 = is_valid_dimension(value_00), gVar1 == 0)) {
    return 0;
  }
  lVar2 = clutter_get_default_backend();
  if (lVar2 == 0) {
    return 0;
  }
  lVar2 = clutter_backend_get_cogl_context(lVar2);
  if (lVar2 == 0) {
    return 0;
  }
  clear_framebuffer_data(data);
  pCVar3 = (CoglTexture *)cogl_texture_2d_new_with_size(lVar2,(int)value,(int)value_00);
  data->texture = pCVar3;
  if (data->texture == (CoglTexture *)0x0) {
    return 0;
  }
  cogl_pipeline_set_layer_texture(data->pipeline,0,data->texture);
  ptr = (gpointer)cogl_offscreen_new_with_texture(data->texture);
  pCVar4 = COGL_FRAMEBUFFER(ptr);
  data->framebuffer = pCVar4;
  if (data->framebuffer == (CoglFramebuffer *)0x0) {
    g_log(0,0x10,"%s: Unable to create an Offscreen buffer","../src/liquid-glass-effect.c:452");
    clear_framebuffer_data(data);
    return 0;
  }
  setup_projection_matrix(data->framebuffer,value,value_00);
  return 1;
}



// WARNING: Enum "AtkRole": Some values do not have unique names

gboolean update_actor_fbo(GbLiquidGlassEffect *self,float width,float height,float downscale_factor)

{
  gboolean gVar1;
  float downscale_factor_local;
  float height_local;
  float width_local;
  GbLiquidGlassEffect *self_local;
  
  if ((((self->tex_width == width) && (self->tex_height == height)) &&
      (self->downscale_factor == downscale_factor)) &&
     ((self->actor_fb).framebuffer != (CoglFramebuffer *)0x0)) {
    gVar1 = 1;
  }
  else {
    self->cache_flags = self->cache_flags & ~ACTOR_PAINTED;
    gVar1 = update_fbo(&self->actor_fb,width,height,downscale_factor);
  }
  return gVar1;
}



// WARNING: Enum "AtkRole": Some values do not have unique names

gboolean update_brightness_fbo
                   (GbLiquidGlassEffect *self,float width,float height,float downscale_factor)

{
  gboolean gVar1;
  float downscale_factor_local;
  float height_local;
  float width_local;
  GbLiquidGlassEffect *self_local;
  
  if ((((self->tex_width == width) && (self->tex_height == height)) &&
      (self->downscale_factor == downscale_factor)) &&
     ((self->brightness_fb).framebuffer != (CoglFramebuffer *)0x0)) {
    gVar1 = 1;
  }
  else {
    gVar1 = update_fbo(&self->brightness_fb,width,height,downscale_factor);
  }
  return gVar1;
}



// WARNING: Enum "AtkRole": Some values do not have unique names

gboolean update_background_fbo(GbLiquidGlassEffect *self,float width,float height)

{
  gboolean gVar1;
  float height_local;
  float width_local;
  GbLiquidGlassEffect *self_local;
  
  if (((self->tex_width == width) && (self->tex_height == height)) &&
     ((self->background_fb).framebuffer != (CoglFramebuffer *)0x0)) {
    gVar1 = 1;
  }
  else {
    gVar1 = update_fbo(&self->background_fb,width,height,1.0);
  }
  return gVar1;
}



// WARNING: Enum "AtkRole": Some values do not have unique names

gboolean update_mask_fbo(GbLiquidGlassEffect *self,float width,float height,float downscale_factor)

{
  gboolean gVar1;
  float downscale_factor_local;
  float height_local;
  float width_local;
  GbLiquidGlassEffect *self_local;
  
  if ((((self->tex_width == width) && (self->tex_height == height)) &&
      (self->downscale_factor == downscale_factor)) &&
     ((self->mask_fb).framebuffer != (CoglFramebuffer *)0x0)) {
    gVar1 = 1;
  }
  else {
    gVar1 = update_fbo(&self->mask_fb,width,height,downscale_factor);
  }
  return gVar1;
}



float calculate_downscale_factor(float width,float height,float radius)

{
  float radius_local;
  float height_local;
  float width_local;
  float downscale_factor;
  float scaled_width;
  float scaled_height;
  float scaled_radius;
  
  downscale_factor = 1.0;
  scaled_width = width;
  scaled_height = height;
  scaled_radius = radius;
  while (((12.0 < scaled_radius && (256.0 < scaled_width)) && (256.0 < scaled_height))) {
    downscale_factor = downscale_factor + downscale_factor;
    scaled_width = width / downscale_factor;
    scaled_radius = radius / downscale_factor;
    scaled_height = height / downscale_factor;
  }
  return downscale_factor;
}



// WARNING: Enum "AtkRole": Some values do not have unique names
// WARNING: Enum "GParamFlags": Some values do not have unique names

void gb_liquid_glass_effect_set_actor(ClutterActorMeta *meta,ClutterActor *actor)

{
  GbLiquidGlassEffect *pGVar1;
  ClutterActorMetaClass *pCVar2;
  ClutterActor *pCVar3;
  ClutterActor *actor_local;
  ClutterActorMeta *meta_local;
  GbLiquidGlassEffect *self;
  ClutterActorMetaClass *meta_class;
  
  pGVar1 = GB_LIQUID_GLASS_EFFECT(meta);
  pCVar2 = CLUTTER_ACTOR_META_CLASS(gb_liquid_glass_effect_parent_class);
  (*pCVar2->set_actor)(meta,actor);
  clear_framebuffer_data(&pGVar1->actor_fb);
  clear_framebuffer_data(&pGVar1->background_fb);
  clear_framebuffer_data(&pGVar1->brightness_fb);
  clear_framebuffer_data(&pGVar1->mask_fb);
  pCVar3 = (ClutterActor *)clutter_actor_meta_get_actor(meta);
  pGVar1->actor = pCVar3;
  return;
}



// WARNING: Enum "AtkRole": Some values do not have unique names

void update_actor_box(GbLiquidGlassEffect *self,ClutterPaintContext *paint_context,
                     ClutterActorBox *source_actor_box)

{
  long lVar1;
  long in_FS_OFFSET;
  ClutterActorBox *source_actor_box_local;
  ClutterPaintContext *paint_context_local;
  GbLiquidGlassEffect *self_local;
  float origin_x;
  float origin_y;
  float width;
  float height;
  float box_scale_factor;
  ClutterStageView *stage_view;
  MtkRectangle stage_view_layout;
  
  lVar1 = *(long *)(in_FS_OFFSET + 0x28);
  box_scale_factor = 1.0;
  if (self->mode == GB_BLUR_MODE_ACTOR) {
    clutter_actor_get_allocation_box(self->actor,source_actor_box);
  }
  else if (self->mode == GB_BLUR_MODE_BACKGROUND) {
    stage_view = (ClutterStageView *)clutter_paint_context_get_stage_view(paint_context);
    clutter_actor_get_transformed_position(self->actor,&origin_x,&origin_y);
    clutter_actor_get_transformed_size(self->actor,&width,&height);
    if (stage_view != (ClutterStageView *)0x0) {
      box_scale_factor = (float)clutter_stage_view_get_scale(stage_view);
      clutter_stage_view_get_layout(stage_view,&stage_view_layout);
      origin_x = origin_x - (float)stage_view_layout.x;
      origin_y = origin_y - (float)stage_view_layout.y;
    }
    clutter_actor_box_set_origin(origin_x,source_actor_box);
    clutter_actor_box_set_size(width,source_actor_box);
    clutter_actor_box_scale(box_scale_factor,source_actor_box);
  }
  clutter_actor_box_clamp_to_pixel(source_actor_box);
  if (lVar1 == *(long *)(in_FS_OFFSET + 0x28)) {
    return;
  }
                    // WARNING: Subroutine does not return
  __stack_chk_fail();
}



void add_paint_rectangle(ClutterPaintNode *node,float width,float height)

{
  long in_FS_OFFSET;
  float height_local;
  float width_local;
  ClutterPaintNode *node_local;
  undefined4 local_28;
  undefined4 local_24;
  float local_20;
  float local_1c;
  long local_10;
  
  local_10 = *(long *)(in_FS_OFFSET + 0x28);
  local_28 = 0;
  local_24 = 0;
  local_20 = width;
  local_1c = height;
  clutter_paint_node_add_rectangle(node,&local_28);
  if (local_10 != *(long *)(in_FS_OFFSET + 0x28)) {
                    // WARNING: Subroutine does not return
    __stack_chk_fail();
  }
  return;
}



// WARNING: Enum "AtkRole": Some values do not have unique names

void add_blurred_pipeline(GbLiquidGlassEffect *self,ClutterPaintNode *node,uint8_t paint_opacity)

{
  long in_FS_OFFSET;
  uint8_t paint_opacity_local;
  ClutterPaintNode *node_local;
  GbLiquidGlassEffect *self_local;
  float width;
  float height;
  ClutterPaintNode_autoptr pipeline_node;
  long local_10;
  
  local_10 = *(long *)(in_FS_OFFSET + 0x28);
  pipeline_node = (ClutterPaintNode_autoptr)0x0;
  clutter_actor_get_size(self->actor,&width,&height);
  update_brightness(self,paint_opacity);
  update_mask_uniforms(self,width,height);
  pipeline_node = (ClutterPaintNode_autoptr)clutter_pipeline_node_new((self->mask_fb).pipeline);
  clutter_paint_node_set_static_name(pipeline_node,"GbLiquidGlassEffect (final)");
  clutter_paint_node_add_child(node,pipeline_node);
  add_paint_rectangle(pipeline_node,width,height);
  glib_autoptr_cleanup_ClutterPaintNode(&pipeline_node);
  if (local_10 != *(long *)(in_FS_OFFSET + 0x28)) {
                    // WARNING: Subroutine does not return
    __stack_chk_fail();
  }
  return;
}



// WARNING: Removing unreachable block (ram,0x00107d52)
// WARNING: Removing unreachable block (ram,0x00107c11)
// WARNING: Removing unreachable block (ram,0x00107c58)
// WARNING: Removing unreachable block (ram,0x00107d99)
// WARNING: Enum "AtkRole": Some values do not have unique names

ClutterPaintNode *
create_blur_nodes(GbLiquidGlassEffect *self,ClutterPaintNode *node,uint8_t paint_opacity)

{
  uint uVar1;
  uint uVar2;
  ClutterPaintNode *pCVar3;
  long in_FS_OFFSET;
  uint8_t paint_opacity_local;
  ClutterPaintNode *node_local;
  GbLiquidGlassEffect *self_local;
  float width;
  float height;
  ClutterPaintNode_autoptr brightness_node;
  ClutterPaintNode_autoptr blur_node;
  ClutterPaintNode_autoptr mask_node;
  long local_20;
  
  local_20 = *(long *)(in_FS_OFFSET + 0x28);
  brightness_node = (ClutterPaintNode_autoptr)0x0;
  blur_node = (ClutterPaintNode_autoptr)0x0;
  mask_node = (ClutterPaintNode_autoptr)0x0;
  clutter_actor_get_size(self->actor,&width,&height);
  update_mask_uniforms(self,width,height);
  mask_node = (ClutterPaintNode_autoptr)
              clutter_layer_node_new_to_framebuffer
                        ((self->mask_fb).framebuffer,(self->mask_fb).pipeline);
  clutter_paint_node_set_static_name(mask_node,"ShellLiquidGlassEffect (mask)");
  clutter_paint_node_add_child(node,mask_node);
  add_paint_rectangle(mask_node,width,height);
  update_brightness(self,paint_opacity);
  brightness_node =
       (ClutterPaintNode_autoptr)
       clutter_layer_node_new_to_framebuffer
                 ((self->brightness_fb).framebuffer,(self->brightness_fb).pipeline);
  clutter_paint_node_set_static_name(brightness_node,"ShellLiquidGlassEffect (brightness)");
  clutter_paint_node_add_child(mask_node,brightness_node);
  uVar1 = cogl_texture_get_height((self->mask_fb).texture);
  uVar2 = cogl_texture_get_width((self->mask_fb).texture);
  add_paint_rectangle(brightness_node,(float)uVar2,(float)uVar1);
  blur_node = (ClutterPaintNode_autoptr)
              clutter_blur_node_new
                        ((float)self->radius / self->downscale_factor,
                         (long)(self->tex_width / self->downscale_factor) & 0xffffffff,
                         (long)(self->tex_height / self->downscale_factor) & 0xffffffff);
  clutter_paint_node_set_static_name(blur_node,"ShellLiquidGlassEffect (blur)");
  clutter_paint_node_add_child(brightness_node,blur_node);
  uVar1 = cogl_texture_get_height((self->mask_fb).texture);
  uVar2 = cogl_texture_get_width((self->mask_fb).texture);
  add_paint_rectangle(blur_node,(float)uVar2,(float)uVar1);
  self->cache_flags = self->cache_flags | BLUR_APPLIED;
  pCVar3 = g_steal_pointer(&blur_node);
  glib_autoptr_cleanup_ClutterPaintNode(&mask_node);
  glib_autoptr_cleanup_ClutterPaintNode(&blur_node);
  glib_autoptr_cleanup_ClutterPaintNode(&brightness_node);
  if (local_20 == *(long *)(in_FS_OFFSET + 0x28)) {
    return pCVar3;
  }
                    // WARNING: Subroutine does not return
  __stack_chk_fail();
}



// WARNING: Enum "AtkRole": Some values do not have unique names

void paint_background(GbLiquidGlassEffect *self,ClutterPaintNode *node,
                     ClutterPaintContext *paint_context,ClutterActorBox *source_actor_box)

{
  undefined8 uVar1;
  long in_FS_OFFSET;
  ClutterActorBox *source_actor_box_local;
  ClutterPaintContext *paint_context_local;
  ClutterPaintNode *node_local;
  GbLiquidGlassEffect *self_local;
  float transformed_x;
  float transformed_y;
  float transformed_width;
  float transformed_height;
  ClutterPaintNode_autoptr background_node;
  ClutterPaintNode_autoptr blit_node;
  CoglFramebuffer *src;
  long local_30;
  
  local_30 = *(long *)(in_FS_OFFSET + 0x28);
  background_node = (ClutterPaintNode_autoptr)0x0;
  blit_node = (ClutterPaintNode_autoptr)0x0;
  clutter_actor_box_get_origin(source_actor_box,&transformed_x,&transformed_y);
  clutter_actor_box_get_size(source_actor_box,&transformed_width,&transformed_height);
  background_node =
       (ClutterPaintNode_autoptr)
       clutter_layer_node_new_to_framebuffer
                 ((self->background_fb).framebuffer,(self->background_fb).pipeline);
  clutter_paint_node_set_static_name(background_node,"GbLiquidGlassEffect (background)");
  clutter_paint_node_add_child(node,background_node);
  add_paint_rectangle(background_node,self->tex_width / self->downscale_factor,
                      self->tex_height / self->downscale_factor);
  src = (CoglFramebuffer *)clutter_paint_context_get_framebuffer(paint_context);
  blit_node = (ClutterPaintNode_autoptr)clutter_blit_node_new(src);
  clutter_paint_node_set_static_name(blit_node,"GbLiquidGlassEffect (blit)");
  clutter_paint_node_add_child(background_node,blit_node);
  uVar1 = clutter_blit_node_get_type();
  uVar1 = g_type_check_instance_cast(blit_node,uVar1);
  clutter_blit_node_add_blit_rectangle
            (uVar1,(int)transformed_x,(int)transformed_y,0,0,(int)transformed_width,
             (int)transformed_height);
  glib_autoptr_cleanup_ClutterPaintNode(&blit_node);
  glib_autoptr_cleanup_ClutterPaintNode(&background_node);
  if (local_30 != *(long *)(in_FS_OFFSET + 0x28)) {
                    // WARNING: Subroutine does not return
    __stack_chk_fail();
  }
  return;
}



// WARNING: Enum "AtkRole": Some values do not have unique names

gboolean update_framebuffers(GbLiquidGlassEffect *self,ClutterActorBox *source_actor_box)

{
  gboolean gVar1;
  long in_FS_OFFSET;
  ClutterActorBox *source_actor_box_local;
  GbLiquidGlassEffect *self_local;
  float height;
  float width;
  gboolean updated;
  float downscale_factor;
  long local_10;
  
  local_10 = *(long *)(in_FS_OFFSET + 0x28);
  updated = 0;
  height = -1.0;
  width = -1.0;
  clutter_actor_box_get_size(source_actor_box,&width,&height);
  gVar1 = is_valid_dimension(width);
  if ((gVar1 == 0) || (gVar1 = is_valid_dimension(height), gVar1 == 0)) {
    gVar1 = 0;
  }
  else {
    downscale_factor = calculate_downscale_factor(width,height,(float)self->radius);
    gVar1 = update_actor_fbo(self,width,height,downscale_factor);
    if ((gVar1 == 0) ||
       ((gVar1 = update_brightness_fbo(self,width,height,downscale_factor), gVar1 == 0 ||
        (gVar1 = update_mask_fbo(self,width,height,downscale_factor), gVar1 == 0)))) {
      updated = 0;
    }
    else {
      updated = 1;
    }
    if (self->mode == GB_BLUR_MODE_BACKGROUND) {
      if ((updated == 0) || (gVar1 = update_background_fbo(self,width,height), gVar1 == 0)) {
        updated = 0;
      }
      else {
        updated = 1;
      }
    }
    gVar1 = updated;
    if (updated != 0) {
      self->tex_width = width;
      self->tex_height = height;
      self->downscale_factor = downscale_factor;
    }
  }
  if (local_10 == *(long *)(in_FS_OFFSET + 0x28)) {
    return gVar1;
  }
                    // WARNING: Subroutine does not return
  __stack_chk_fail();
}



// WARNING: Enum "AtkRole": Some values do not have unique names

void add_actor_node(GbLiquidGlassEffect *self,ClutterPaintNode *node,int opacity)

{
  long in_FS_OFFSET;
  int opacity_local;
  ClutterPaintNode *node_local;
  GbLiquidGlassEffect *self_local;
  ClutterPaintNode_autoptr actor_node;
  long local_10;
  
  local_10 = *(long *)(in_FS_OFFSET + 0x28);
  actor_node = (ClutterPaintNode_autoptr)0x0;
  actor_node = (ClutterPaintNode_autoptr)clutter_actor_node_new(self->actor,opacity);
  clutter_paint_node_add_child(node,actor_node);
  glib_autoptr_cleanup_ClutterPaintNode(&actor_node);
  if (local_10 != *(long *)(in_FS_OFFSET + 0x28)) {
                    // WARNING: Subroutine does not return
    __stack_chk_fail();
  }
  return;
}



// WARNING: Enum "AtkRole": Some values do not have unique names

void paint_actor_offscreen
               (GbLiquidGlassEffect *self,ClutterPaintNode *node,ClutterEffectPaintFlags flags)

{
  long lVar1;
  long in_FS_OFFSET;
  ClutterEffectPaintFlags flags_local;
  ClutterPaintNode *node_local;
  GbLiquidGlassEffect *self_local;
  gboolean actor_dirty;
  ClutterPaintNode_autoptr transform_node;
  ClutterPaintNode_autoptr layer_node;
  graphene_matrix_t transform;
  
  lVar1 = *(long *)(in_FS_OFFSET + 0x28);
  if (((flags & CLUTTER_EFFECT_PAINT_ACTOR_DIRTY) == 0) &&
     ((self->cache_flags & ACTOR_PAINTED) != 0)) {
    transform.__graphene_private_value.x[0] = 0.0;
    transform.__graphene_private_value.x[1] = 0.0;
    transform.__graphene_private_value.x._0_8_ =
         clutter_pipeline_node_new((self->actor_fb).pipeline);
    clutter_paint_node_set_static_name
              (transform.__graphene_private_value.x._0_8_,"GbLiquidGlassEffect (actor texture)");
    clutter_paint_node_add_child(node,transform.__graphene_private_value.x._0_8_);
    add_paint_rectangle((ClutterPaintNode *)transform.__graphene_private_value.x._0_8_,
                        self->tex_width / self->downscale_factor,
                        self->tex_height / self->downscale_factor);
    glib_autoptr_cleanup_ClutterPaintNode((ClutterPaintNode **)&transform);
  }
  else {
    transform_node = (ClutterPaintNode_autoptr)0x0;
    layer_node = (ClutterPaintNode_autoptr)0x0;
    layer_node = (ClutterPaintNode_autoptr)
                 clutter_layer_node_new_to_framebuffer
                           ((self->actor_fb).framebuffer,(self->actor_fb).pipeline);
    clutter_paint_node_set_static_name(layer_node,"GbLiquidGlassEffect (actor offscreen)");
    clutter_paint_node_add_child(node,layer_node);
    add_paint_rectangle(layer_node,self->tex_width / self->downscale_factor,
                        self->tex_height / self->downscale_factor);
    graphene_matrix_init_scale
              (1.0 / self->downscale_factor,1.0 / self->downscale_factor,0x3f800000,&transform);
    transform_node = (ClutterPaintNode_autoptr)clutter_transform_node_new(&transform);
    clutter_paint_node_set_static_name(transform_node,"GbLiquidGlassEffect (downscale)");
    clutter_paint_node_add_child(layer_node,transform_node);
    add_actor_node(self,transform_node,0xff);
    self->cache_flags = self->cache_flags | ACTOR_PAINTED;
    glib_autoptr_cleanup_ClutterPaintNode(&layer_node);
    glib_autoptr_cleanup_ClutterPaintNode(&transform_node);
  }
  if (lVar1 != *(long *)(in_FS_OFFSET + 0x28)) {
                    // WARNING: Subroutine does not return
    __stack_chk_fail();
  }
  return;
}



// WARNING: Enum "AtkRole": Some values do not have unique names

gboolean needs_repaint(GbLiquidGlassEffect *self,ClutterEffectPaintFlags flags)

{
  gboolean gVar1;
  ClutterEffectPaintFlags flags_local;
  GbLiquidGlassEffect *self_local;
  gboolean actor_dirty;
  gboolean blur_cached;
  gboolean actor_cached;
  
  if (self->mode == GB_BLUR_MODE_ACTOR) {
    if ((((flags & CLUTTER_EFFECT_PAINT_ACTOR_DIRTY) == 0) &&
        ((self->cache_flags & BLUR_APPLIED) != 0)) && ((self->cache_flags & ACTOR_PAINTED) != 0)) {
      gVar1 = 0;
    }
    else {
      gVar1 = 1;
    }
  }
  else if (self->mode == GB_BLUR_MODE_BACKGROUND) {
    gVar1 = 1;
  }
  else {
    gVar1 = 1;
  }
  return gVar1;
}



// WARNING: Enum "AtkRole": Some values do not have unique names

void gb_liquid_glass_effect_paint_node
               (ClutterEffect *effect,ClutterPaintNode *node,ClutterPaintContext *paint_context,
               ClutterEffectPaintFlags flags)

{
  long lVar1;
  bool bVar2;
  gboolean gVar3;
  long in_FS_OFFSET;
  ClutterEffectPaintFlags flags_local;
  ClutterPaintContext *paint_context_local;
  ClutterPaintNode *node_local;
  ClutterEffect *effect_local;
  uint8_t paint_opacity;
  ClutterPaintNode_autoptr blur_node;
  GbLiquidGlassEffect *self;
  ClutterActorBox source_actor_box;
  
  lVar1 = *(long *)(in_FS_OFFSET + 0x28);
  self = GB_LIQUID_GLASS_EFFECT(effect);
  if (self->actor == (ClutterActor *)0x0) goto LAB_00108720;
  if (0 < self->radius) {
    blur_node = (ClutterPaintNode_autoptr)0x0;
    if (self->mode == GB_BLUR_MODE_ACTOR) {
      paint_opacity = clutter_actor_get_paint_opacity(self->actor);
LAB_001085f5:
      gVar3 = needs_repaint(self,flags);
      if (gVar3 == 0) {
        add_blurred_pipeline(self,node,paint_opacity);
      }
      else {
        update_actor_box(self,paint_context,&source_actor_box);
        gVar3 = update_framebuffers(self,&source_actor_box);
        if (gVar3 == 0) {
          bVar2 = false;
          goto LAB_001086f2;
        }
        blur_node = create_blur_nodes(self,node,paint_opacity);
        if (self->mode == GB_BLUR_MODE_ACTOR) {
          paint_actor_offscreen(self,blur_node,flags);
        }
        else if (self->mode == GB_BLUR_MODE_BACKGROUND) {
          paint_background(self,blur_node,paint_context,&source_actor_box);
        }
      }
      if ((self->mode != GB_BLUR_MODE_ACTOR) && (self->mode == GB_BLUR_MODE_BACKGROUND)) {
        add_actor_node(self,node,-1);
      }
      bVar2 = true;
    }
    else {
      if (self->mode == GB_BLUR_MODE_BACKGROUND) {
        paint_opacity = 0xff;
        goto LAB_001085f5;
      }
      bVar2 = false;
    }
LAB_001086f2:
    glib_autoptr_cleanup_ClutterPaintNode(&blur_node);
    if (bVar2) goto LAB_00108720;
  }
  add_actor_node(self,node,-1);
LAB_00108720:
  if (lVar1 == *(long *)(in_FS_OFFSET + 0x28)) {
    return;
  }
                    // WARNING: Subroutine does not return
  __stack_chk_fail();
}



// WARNING: Enum "AtkRole": Some values do not have unique names

void gb_liquid_glass_effect_finalize(GObject *object)

{
  GTypeClass *pGVar1;
  GData *pGVar2;
  long lVar3;
  GObject *object_local;
  GbLiquidGlassEffect *self;
  CoglPipeline **_pp;
  CoglPipeline *_ptr;
  CoglPipeline **_pp_1;
  CoglPipeline *_ptr_1;
  CoglPipeline **_pp_2;
  CoglPipeline *_ptr_2;
  CoglPipeline **_pp_3;
  CoglPipeline *_ptr_3;
  
  clear_framebuffer_data((FramebufferData *)&object[1].qdata);
  clear_framebuffer_data((FramebufferData *)(object + 3));
  clear_framebuffer_data((FramebufferData *)(object + 4));
  clear_framebuffer_data((FramebufferData *)&object[5].ref_count);
  pGVar1 = object[2].g_type_instance.g_class;
  object[2].g_type_instance.g_class = (GTypeClass *)0x0;
  if (pGVar1 != (GTypeClass *)0x0) {
    g_object_unref(pGVar1);
  }
  lVar3 = *(long *)&object[3].ref_count;
  *(undefined8 *)&object[3].ref_count = 0;
  if (lVar3 != 0) {
    g_object_unref(lVar3);
  }
  lVar3 = *(long *)&object[4].ref_count;
  *(undefined8 *)&object[4].ref_count = 0;
  if (lVar3 != 0) {
    g_object_unref(lVar3);
  }
  pGVar2 = object[5].qdata;
  object[5].qdata = (GData *)0x0;
  if (pGVar2 != (GData *)0x0) {
    g_object_unref(pGVar2);
  }
  lVar3 = g_type_check_class_cast(gb_liquid_glass_effect_parent_class,0x50);
  (**(code **)(lVar3 + 0x30))(object);
  return;
}



// WARNING: Enum "GParamFlags": Some values do not have unique names
// WARNING: Enum "AtkRole": Some values do not have unique names

void gb_liquid_glass_effect_get_property
               (GObject *object,guint prop_id,GValue *value,GParamSpec *pspec)

{
  GbLiquidGlassEffect *pGVar1;
  undefined8 uVar2;
  undefined8 uVar3;
  GParamSpec *pspec_local;
  GValue *value_local;
  guint prop_id_local;
  GObject *object_local;
  guint _glib__property_id;
  GbLiquidGlassEffect *self;
  GObject *_glib__object;
  GParamSpec *_glib__pspec;
  
  pGVar1 = GB_LIQUID_GLASS_EFFECT(object);
  if (prop_id == 7) {
    g_value_set_float(pGVar1->depth,value);
    return;
  }
  if (prop_id < 8) {
    if (prop_id == 6) {
      g_value_set_float(pGVar1->refraction,value);
      return;
    }
    if (prop_id < 7) {
      if (prop_id == 5) {
        g_value_set_float(pGVar1->highlight,value);
        return;
      }
      if (prop_id < 6) {
        if (prop_id == 4) {
          g_value_set_float(pGVar1->corner_radius,value);
          return;
        }
        if (prop_id < 5) {
          if (prop_id == 3) {
            g_value_set_enum(value,pGVar1->mode);
            return;
          }
          if (prop_id < 4) {
            if (prop_id == 1) {
              g_value_set_int(value,pGVar1->radius);
              return;
            }
            if (prop_id == 2) {
              g_value_set_float(pGVar1->brightness,value);
              return;
            }
          }
        }
      }
    }
  }
  uVar2 = g_type_name(((object->g_type_instance).g_class)->g_type);
  uVar3 = g_type_name(((pspec->g_type_instance).g_class)->g_type);
  g_log(0,0x10,"%s:%d: invalid %s id %u for \"%s\" of type \'%s\' in \'%s\'",
        "../src/liquid-glass-effect.c",0x3f5,"property",prop_id,pspec->name,uVar3,uVar2);
  return;
}



// WARNING: Enum "GParamFlags": Some values do not have unique names
// WARNING: Enum "AtkRole": Some values do not have unique names

void gb_liquid_glass_effect_set_property
               (GObject *object,guint prop_id,GValue *value,GParamSpec *pspec)

{
  int radius;
  GbBlurMode mode;
  GbLiquidGlassEffect *self_00;
  undefined8 uVar1;
  undefined8 uVar2;
  float fVar3;
  GParamSpec *pspec_local;
  GValue *value_local;
  guint prop_id_local;
  GObject *object_local;
  guint _glib__property_id;
  GbLiquidGlassEffect *self;
  GObject *_glib__object;
  GParamSpec *_glib__pspec;
  
  self_00 = GB_LIQUID_GLASS_EFFECT(object);
  if (prop_id == 7) {
    fVar3 = (float)g_value_get_float(value);
    gb_liquid_glass_effect_set_depth(self_00,fVar3);
    return;
  }
  if (prop_id < 8) {
    if (prop_id == 6) {
      fVar3 = (float)g_value_get_float(value);
      gb_liquid_glass_effect_set_refraction(self_00,fVar3);
      return;
    }
    if (prop_id < 7) {
      if (prop_id == 5) {
        fVar3 = (float)g_value_get_float(value);
        gb_liquid_glass_effect_set_highlight(self_00,fVar3);
        return;
      }
      if (prop_id < 6) {
        if (prop_id == 4) {
          fVar3 = (float)g_value_get_float(value);
          gb_liquid_glass_effect_set_corner_radius(self_00,fVar3);
          return;
        }
        if (prop_id < 5) {
          if (prop_id == 3) {
            mode = g_value_get_enum(value);
            gb_liquid_glass_effect_set_mode(self_00,mode);
            return;
          }
          if (prop_id < 4) {
            if (prop_id == 1) {
              radius = g_value_get_int(value);
              gb_liquid_glass_effect_set_radius(self_00,radius);
              return;
            }
            if (prop_id == 2) {
              fVar3 = (float)g_value_get_float(value);
              gb_liquid_glass_effect_set_brightness(self_00,fVar3);
              return;
            }
          }
        }
      }
    }
  }
  uVar1 = g_type_name(((object->g_type_instance).g_class)->g_type);
  uVar2 = g_type_name(((pspec->g_type_instance).g_class)->g_type);
  g_log(0,0x10,"%s:%d: invalid %s id %u for \"%s\" of type \'%s\' in \'%s\'",
        "../src/liquid-glass-effect.c",0x420,"property",prop_id,pspec->name,uVar2,uVar1);
  return;
}



// WARNING: Enum "GParamFlags": Some values do not have unique names
// WARNING: Enum "AtkRole": Some values do not have unique names

void gb_liquid_glass_effect_class_init(GbLiquidGlassEffectClass *klass)

{
  long lVar1;
  ClutterActorMetaClass *pCVar2;
  ClutterEffectClass *pCVar3;
  GType GVar4;
  GbLiquidGlassEffectClass *klass_local;
  GObjectClass *object_class;
  ClutterActorMetaClass *meta_class;
  ClutterEffectClass *effect_class;
  
  lVar1 = g_type_check_class_cast(klass,0x50);
  pCVar2 = CLUTTER_ACTOR_META_CLASS(klass);
  pCVar3 = CLUTTER_EFFECT_CLASS(klass);
  *(code **)(lVar1 + 0x30) = gb_liquid_glass_effect_finalize;
  *(code **)(lVar1 + 0x20) = gb_liquid_glass_effect_get_property;
  *(code **)(lVar1 + 0x18) = gb_liquid_glass_effect_set_property;
  pCVar2->set_actor = gb_liquid_glass_effect_set_actor;
  pCVar3->paint_node = gb_liquid_glass_effect_paint_node;
  properties[1] = (GParamSpec *)g_param_spec_int("radius",0,0,0,0x7fffffff,0,0x400000e3);
  properties[2] = (GParamSpec *)g_param_spec_float(0,0x3f800000,"brightness",0,0,0x400000e3);
  GVar4 = gb_blur_mode_get_type();
  properties[3] = (GParamSpec *)g_param_spec_enum(&DAT_0010b938,0,0,GVar4,0,0x400000e3);
  properties[4] = (GParamSpec *)g_param_spec_float(0,0x7f7fffff,0,"corner-radius",0,0,0x400000e3);
  properties[5] = (GParamSpec *)g_param_spec_float(0,0x3f800000,"highlight",0,0,0x400000e3);
  properties[6] = (GParamSpec *)g_param_spec_float(0,0x42a00000,"refraction",0,0,0x400000e3);
  properties[7] = (GParamSpec *)g_param_spec_float(0,0x41c00000,"depth",0,0,0x400000e3);
  g_object_class_install_properties(lVar1,8,properties);
  return;
}



// WARNING: Enum "AtkRole": Some values do not have unique names

void gb_liquid_glass_effect_init(GbLiquidGlassEffect *self)

{
  int iVar1;
  CoglPipeline *pCVar2;
  GbLiquidGlassEffect *self_local;
  
  self->mode = GB_BLUR_MODE_ACTOR;
  self->radius = 0;
  self->brightness = 1.0;
  self->corner_radius = 0.0;
  self->highlight = 0.35;
  self->refraction = 24.0;
  self->depth = 6.9;
  pCVar2 = create_base_pipeline();
  (self->actor_fb).pipeline = pCVar2;
  pCVar2 = create_base_pipeline();
  (self->background_fb).pipeline = pCVar2;
  pCVar2 = create_brightness_pipeline();
  (self->brightness_fb).pipeline = pCVar2;
  pCVar2 = create_mask_pipeline();
  (self->mask_fb).pipeline = pCVar2;
  iVar1 = cogl_pipeline_get_uniform_location((self->brightness_fb).pipeline,"brightness");
  self->brightness_uniform = iVar1;
  iVar1 = cogl_pipeline_get_uniform_location((self->mask_fb).pipeline,"u_corner_radius");
  self->corner_radius_uniform = iVar1;
  iVar1 = cogl_pipeline_get_uniform_location((self->mask_fb).pipeline,"u_size");
  self->mask_size_uniform = iVar1;
  iVar1 = cogl_pipeline_get_uniform_location((self->mask_fb).pipeline,"u_highlight");
  self->highlight_uniform = iVar1;
  iVar1 = cogl_pipeline_get_uniform_location((self->mask_fb).pipeline,"u_refraction");
  self->refraction_uniform = iVar1;
  iVar1 = cogl_pipeline_get_uniform_location((self->mask_fb).pipeline,"u_depth");
  self->depth_uniform = iVar1;
  return;
}



// WARNING: Unknown calling convention -- yet parameter storage is locked
// WARNING: Enum "AtkRole": Some values do not have unique names

GbLiquidGlassEffect * gb_liquid_glass_effect_new(void)

{
  GType GVar1;
  GbLiquidGlassEffect *pGVar2;
  
  GVar1 = gb_liquid_glass_effect_get_type();
  pGVar2 = (GbLiquidGlassEffect *)g_object_new(GVar1,0);
  return pGVar2;
}



// WARNING: Enum "AtkRole": Some values do not have unique names

int gb_liquid_glass_effect_get_radius(GbLiquidGlassEffect *self)

{
  gboolean gVar1;
  int iVar2;
  GbLiquidGlassEffect *self_local;
  
  gVar1 = GB_IS_LIQUID_GLASS_EFFECT(self);
  if (gVar1 == 0) {
    g_return_if_fail_warning
              (0,"gb_liquid_glass_effect_get_radius","GB_IS_LIQUID_GLASS_EFFECT (self)");
    iVar2 = 0;
  }
  else {
    iVar2 = self->radius;
  }
  return iVar2;
}



// WARNING: Enum "AtkRole": Some values do not have unique names
// WARNING: Enum "GParamFlags": Some values do not have unique names

void gb_liquid_glass_effect_set_radius(GbLiquidGlassEffect *self,int radius)

{
  GParamSpec *pGVar1;
  gboolean gVar2;
  ClutterEffect *pCVar3;
  undefined8 uVar4;
  int radius_local;
  GbLiquidGlassEffect *self_local;
  
  gVar2 = GB_IS_LIQUID_GLASS_EFFECT(self);
  if (gVar2 == 0) {
    g_return_if_fail_warning
              (0,"gb_liquid_glass_effect_set_radius","GB_IS_LIQUID_GLASS_EFFECT (self)");
  }
  else {
    if (radius < 0) {
      radius = 0;
    }
    if (radius != self->radius) {
      self->radius = radius;
      self->cache_flags = self->cache_flags & ~BLUR_APPLIED;
      if (self->actor != (ClutterActor *)0x0) {
        pCVar3 = CLUTTER_EFFECT(self);
        clutter_effect_queue_repaint(pCVar3);
      }
      pGVar1 = properties[1];
      uVar4 = g_type_check_instance_cast(self,0x50);
      g_object_notify_by_pspec(uVar4,pGVar1);
    }
  }
  return;
}



// WARNING: Enum "AtkRole": Some values do not have unique names

float gb_liquid_glass_effect_get_brightness(GbLiquidGlassEffect *self)

{
  gboolean gVar1;
  float fVar2;
  GbLiquidGlassEffect *self_local;
  
  gVar1 = GB_IS_LIQUID_GLASS_EFFECT(self);
  if (gVar1 == 0) {
    g_return_if_fail_warning
              (0,"gb_liquid_glass_effect_get_brightness","GB_IS_LIQUID_GLASS_EFFECT (self)");
    fVar2 = -1.0;
  }
  else {
    fVar2 = self->brightness;
  }
  return fVar2;
}



// WARNING: Enum "AtkRole": Some values do not have unique names
// WARNING: Enum "GParamFlags": Some values do not have unique names

void gb_liquid_glass_effect_set_brightness(GbLiquidGlassEffect *self,float brightness)

{
  GParamSpec *pGVar1;
  gboolean gVar2;
  ClutterEffect *pCVar3;
  undefined8 uVar4;
  float fVar5;
  float brightness_local;
  GbLiquidGlassEffect *self_local;
  
  gVar2 = GB_IS_LIQUID_GLASS_EFFECT(self);
  if (gVar2 == 0) {
    g_return_if_fail_warning
              (0,"gb_liquid_glass_effect_set_brightness","GB_IS_LIQUID_GLASS_EFFECT (self)");
  }
  else {
    fVar5 = sanitize_float_property(brightness,0.0,1.0,1.0);
    if (self->brightness != fVar5) {
      self->brightness = fVar5;
      self->cache_flags = self->cache_flags & ~BLUR_APPLIED;
      if (self->actor != (ClutterActor *)0x0) {
        pCVar3 = CLUTTER_EFFECT(self);
        clutter_effect_queue_repaint(pCVar3);
      }
      pGVar1 = properties[2];
      uVar4 = g_type_check_instance_cast(self,0x50);
      g_object_notify_by_pspec(uVar4,pGVar1);
    }
  }
  return;
}



// WARNING: Enum "AtkRole": Some values do not have unique names

GbBlurMode gb_liquid_glass_effect_get_mode(GbLiquidGlassEffect *self)

{
  gboolean gVar1;
  GbBlurMode GVar2;
  GbLiquidGlassEffect *self_local;
  
  gVar1 = GB_IS_LIQUID_GLASS_EFFECT(self);
  if (gVar1 == 0) {
    g_return_if_fail_warning(0,"gb_liquid_glass_effect_get_mode","GB_IS_LIQUID_GLASS_EFFECT (self)")
    ;
    GVar2 = GB_BLUR_MODE_ACTOR;
  }
  else {
    GVar2 = self->mode;
  }
  return GVar2;
}



// WARNING: Enum "AtkRole": Some values do not have unique names
// WARNING: Enum "GParamFlags": Some values do not have unique names

void gb_liquid_glass_effect_set_mode(GbLiquidGlassEffect *self,GbBlurMode mode)

{
  GParamSpec *pGVar1;
  gboolean gVar2;
  ClutterEffect *pCVar3;
  undefined8 uVar4;
  GbBlurMode mode_local;
  GbLiquidGlassEffect *self_local;
  
  gVar2 = GB_IS_LIQUID_GLASS_EFFECT(self);
  if (gVar2 == 0) {
    g_return_if_fail_warning(0,"gb_liquid_glass_effect_set_mode","GB_IS_LIQUID_GLASS_EFFECT (self)")
    ;
  }
  else {
    gVar2 = is_valid_mode(mode);
    mode_local = mode;
    if (gVar2 == 0) {
      mode_local = GB_BLUR_MODE_ACTOR;
    }
    if (mode_local != self->mode) {
      self->mode = mode_local;
      self->cache_flags = self->cache_flags & ~BLUR_APPLIED;
      if (mode_local == GB_BLUR_MODE_ACTOR) {
        clear_framebuffer_data(&self->background_fb);
      }
      if (self->actor != (ClutterActor *)0x0) {
        pCVar3 = CLUTTER_EFFECT(self);
        clutter_effect_queue_repaint(pCVar3);
      }
      pGVar1 = properties[3];
      uVar4 = g_type_check_instance_cast(self,0x50);
      g_object_notify_by_pspec(uVar4,pGVar1);
    }
  }
  return;
}



// WARNING: Enum "AtkRole": Some values do not have unique names

float gb_liquid_glass_effect_get_corner_radius(GbLiquidGlassEffect *self)

{
  gboolean gVar1;
  float fVar2;
  GbLiquidGlassEffect *self_local;
  
  gVar1 = GB_IS_LIQUID_GLASS_EFFECT(self);
  if (gVar1 == 0) {
    g_return_if_fail_warning
              (0,"gb_liquid_glass_effect_get_corner_radius","GB_IS_LIQUID_GLASS_EFFECT (self)");
    fVar2 = 0.0;
  }
  else {
    fVar2 = self->corner_radius;
  }
  return fVar2;
}



// WARNING: Enum "AtkRole": Some values do not have unique names
// WARNING: Enum "GParamFlags": Some values do not have unique names

void gb_liquid_glass_effect_set_corner_radius(GbLiquidGlassEffect *self,float corner_radius)

{
  GParamSpec *pGVar1;
  gboolean gVar2;
  ClutterEffect *pCVar3;
  undefined8 uVar4;
  float fVar5;
  float corner_radius_local;
  GbLiquidGlassEffect *self_local;
  
  gVar2 = GB_IS_LIQUID_GLASS_EFFECT(self);
  if (gVar2 == 0) {
    g_return_if_fail_warning
              (0,"gb_liquid_glass_effect_set_corner_radius","GB_IS_LIQUID_GLASS_EFFECT (self)");
  }
  else {
    fVar5 = sanitize_float_property(corner_radius,0.0,3.4028235e+38,0.0);
    if (self->corner_radius != fVar5) {
      self->corner_radius = fVar5;
      self->cache_flags = self->cache_flags & ~BLUR_APPLIED;
      if (self->actor != (ClutterActor *)0x0) {
        pCVar3 = CLUTTER_EFFECT(self);
        clutter_effect_queue_repaint(pCVar3);
      }
      pGVar1 = properties[4];
      uVar4 = g_type_check_instance_cast(self,0x50);
      g_object_notify_by_pspec(uVar4,pGVar1);
    }
  }
  return;
}



// WARNING: Enum "AtkRole": Some values do not have unique names

float gb_liquid_glass_effect_get_highlight(GbLiquidGlassEffect *self)

{
  gboolean gVar1;
  float fVar2;
  GbLiquidGlassEffect *self_local;
  
  gVar1 = GB_IS_LIQUID_GLASS_EFFECT(self);
  if (gVar1 == 0) {
    g_return_if_fail_warning
              (0,"gb_liquid_glass_effect_get_highlight","GB_IS_LIQUID_GLASS_EFFECT (self)");
    fVar2 = 0.0;
  }
  else {
    fVar2 = self->highlight;
  }
  return fVar2;
}



// WARNING: Enum "AtkRole": Some values do not have unique names
// WARNING: Enum "GParamFlags": Some values do not have unique names

void gb_liquid_glass_effect_set_highlight(GbLiquidGlassEffect *self,float highlight)

{
  GParamSpec *pGVar1;
  gboolean gVar2;
  ClutterEffect *pCVar3;
  undefined8 uVar4;
  float fVar5;
  float highlight_local;
  GbLiquidGlassEffect *self_local;
  
  gVar2 = GB_IS_LIQUID_GLASS_EFFECT(self);
  if (gVar2 == 0) {
    g_return_if_fail_warning
              (0,"gb_liquid_glass_effect_set_highlight","GB_IS_LIQUID_GLASS_EFFECT (self)");
  }
  else {
    fVar5 = sanitize_float_property(highlight,0.0,1.0,0.0);
    if (self->highlight != fVar5) {
      self->highlight = fVar5;
      self->cache_flags = self->cache_flags & ~BLUR_APPLIED;
      if (self->actor != (ClutterActor *)0x0) {
        pCVar3 = CLUTTER_EFFECT(self);
        clutter_effect_queue_repaint(pCVar3);
      }
      pGVar1 = properties[5];
      uVar4 = g_type_check_instance_cast(self,0x50);
      g_object_notify_by_pspec(uVar4,pGVar1);
    }
  }
  return;
}



// WARNING: Enum "AtkRole": Some values do not have unique names

float gb_liquid_glass_effect_get_refraction(GbLiquidGlassEffect *self)

{
  gboolean gVar1;
  float fVar2;
  GbLiquidGlassEffect *self_local;
  
  gVar1 = GB_IS_LIQUID_GLASS_EFFECT(self);
  if (gVar1 == 0) {
    g_return_if_fail_warning
              (0,"gb_liquid_glass_effect_get_refraction","GB_IS_LIQUID_GLASS_EFFECT (self)");
    fVar2 = 0.0;
  }
  else {
    fVar2 = self->refraction;
  }
  return fVar2;
}



// WARNING: Enum "AtkRole": Some values do not have unique names
// WARNING: Enum "GParamFlags": Some values do not have unique names

void gb_liquid_glass_effect_set_refraction(GbLiquidGlassEffect *self,float refraction)

{
  GParamSpec *pGVar1;
  gboolean gVar2;
  ClutterEffect *pCVar3;
  undefined8 uVar4;
  float fVar5;
  float refraction_local;
  GbLiquidGlassEffect *self_local;
  
  gVar2 = GB_IS_LIQUID_GLASS_EFFECT(self);
  if (gVar2 == 0) {
    g_return_if_fail_warning
              (0,"gb_liquid_glass_effect_set_refraction","GB_IS_LIQUID_GLASS_EFFECT (self)");
  }
  else {
    fVar5 = sanitize_float_property(refraction,0.0,80.0,0.0);
    if (self->refraction != fVar5) {
      self->refraction = fVar5;
      self->cache_flags = self->cache_flags & ~BLUR_APPLIED;
      if (self->actor != (ClutterActor *)0x0) {
        pCVar3 = CLUTTER_EFFECT(self);
        clutter_effect_queue_repaint(pCVar3);
      }
      pGVar1 = properties[6];
      uVar4 = g_type_check_instance_cast(self,0x50);
      g_object_notify_by_pspec(uVar4,pGVar1);
    }
  }
  return;
}



// WARNING: Enum "AtkRole": Some values do not have unique names

float gb_liquid_glass_effect_get_depth(GbLiquidGlassEffect *self)

{
  gboolean gVar1;
  float fVar2;
  GbLiquidGlassEffect *self_local;
  
  gVar1 = GB_IS_LIQUID_GLASS_EFFECT(self);
  if (gVar1 == 0) {
    g_return_if_fail_warning
              (0,"gb_liquid_glass_effect_get_depth","GB_IS_LIQUID_GLASS_EFFECT (self)");
    fVar2 = 0.0;
  }
  else {
    fVar2 = self->depth;
  }
  return fVar2;
}



// WARNING: Enum "AtkRole": Some values do not have unique names
// WARNING: Enum "GParamFlags": Some values do not have unique names

void gb_liquid_glass_effect_set_depth(GbLiquidGlassEffect *self,float depth)

{
  GParamSpec *pGVar1;
  gboolean gVar2;
  ClutterEffect *pCVar3;
  undefined8 uVar4;
  float fVar5;
  float depth_local;
  GbLiquidGlassEffect *self_local;
  
  gVar2 = GB_IS_LIQUID_GLASS_EFFECT(self);
  if (gVar2 == 0) {
    g_return_if_fail_warning
              (0,"gb_liquid_glass_effect_set_depth","GB_IS_LIQUID_GLASS_EFFECT (self)");
  }
  else {
    fVar5 = sanitize_float_property(depth,0.0,24.0,6.9);
    if (self->depth != fVar5) {
      self->depth = fVar5;
      self->cache_flags = self->cache_flags & ~BLUR_APPLIED;
      if (self->actor != (ClutterActor *)0x0) {
        pCVar3 = CLUTTER_EFFECT(self);
        clutter_effect_queue_repaint(pCVar3);
      }
      pGVar1 = properties[7];
      uVar4 = g_type_check_instance_cast(self,0x50);
      g_object_notify_by_pspec(uVar4,pGVar1);
    }
  }
  return;
}



// WARNING: Unknown calling convention -- yet parameter storage is locked

GType gb_blur_mode_get_type(void)

{
  undefined8 uVar1;
  
  if (gb_blur_mode_get_type::etype == 0) {
    uVar1 = g_intern_static_string("GbBlurMode");
    gb_blur_mode_get_type::etype =
         g_enum_register_static(uVar1,gb_blur_mode_get_type::lexical_block_0::values);
  }
  return gb_blur_mode_get_type::etype;
}



void _fini(void)

{
  return;
}


