/* 由 tools/导出运行时.mjs 生成，勿手改 */
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <stdbool.h>
#include <math.h>
#include <setjmp.h>
#include <time.h>
#include <sys/stat.h>
#ifdef _WIN32
#include <direct.h>
#include <io.h>
#include <wchar.h>
#else
#include <unistd.h>
#include <dirent.h>
#endif

typedef int64_t CsayInt;
typedef float CsayFloat32;
typedef double CsayFloat;
typedef bool CsayBool;

typedef struct { const char* p; int64_t n; } CsayStr;
typedef struct { int64_t len; int64_t elem; } CsayArrayHead;

typedef struct { CsayStr msg; CsayInt kind; CsayInt ok; } CsayError;

#define CSAY_ERR_BASE 0
#define CSAY_ERR_ARG 1
#define CSAY_ERR_STATE 2
#define CSAY_ERR_FILE 3
#define CSAY_ERR_INDEX 4
#define CSAY_ERR_FORMAT 5

/* ---------------- Windows 控制台适配 ---------------- */

/* 不引 windows.h，直接声明要用的 API，这样 TCC 和 clang 都能编 */
#ifdef _WIN32
__declspec(dllimport) int __stdcall SetConsoleOutputCP(unsigned int cp);
__declspec(dllimport) int __stdcall SetConsoleCP(unsigned int cp);
__declspec(dllimport) wchar_t* __stdcall GetCommandLineW(void);
__declspec(dllimport) int __stdcall MultiByteToWideChar(unsigned int cp, unsigned long flags,
    const char* str, int len, wchar_t* out, int outLen);
__declspec(dllimport) int __stdcall WideCharToMultiByte(unsigned int cp, unsigned long flags,
    const wchar_t* str, int len, char* out, int outLen, const char* def, int* used);
__declspec(dllimport) void* __stdcall GetStdHandle(unsigned long which);
__declspec(dllimport) int __stdcall GetConsoleMode(void* handle, unsigned long* mode);
__declspec(dllimport) int __stdcall ReadConsoleW(void* handle, wchar_t* buf, unsigned long len, unsigned long* read, void* reserved);
#endif

/**
 * 程序启动时把控制台输入、输出都切成 UTF-8。
 * 只改输出的话，控制台按 GBK 交给 fgetc，读进来的中文不是合法 UTF-8，
 * 再打印出来就是空白或乱码。
 */
static void csay_win_init(void) {
#ifdef _WIN32
    SetConsoleOutputCP(65001);
    SetConsoleCP(65001);
#endif
    srand((unsigned)time(NULL));
}

/**
 * 程序结束时的收尾。
 * 双击 exe 时控制台窗口会在程序退出后立刻关闭，用户根本看不到输出。
 * 用环境变量区分：csay.bat / 运行.bat 会设 CSAY_NO_PAUSE=1，
 * 双击启动时没有这个变量，就停一下等回车。
 * （不用 GetConsoleProcessList，TCC 的导入库里没有这个符号）
 */
static void csay_win_finish(void) {
#ifdef _WIN32
    const char* noPause = getenv("CSAY_NO_PAUSE");
    if (noPause != NULL) return;
    printf("\n按回车键退出...");
    fflush(stdout);
    int ch = getchar();
    (void)ch;
#endif
}

static CsayStr csay_str(const char* p, int64_t n) {
    CsayStr s; s.p = p; s.n = n; return s;
}

/* 自举编译器生成的 C 用这个把 C 字符串字面量变成 CsayStr */
static CsayStr csay_lit(const char* p) {
    return csay_str(p, (int64_t)strlen(p));
}

static CsayError csay_error(CsayStr msg, CsayInt kind);
static void csay_throw_error(CsayError e);
static void csay_throw(CsayStr msg);
/* ---------------- 区域分配 ---------------- */
/* 区域内的分配整块回收，不单块 free。适合循环里处理临时数据。 */

typedef struct CsayChunk {
    char* mem;
    int64_t used;
    int64_t cap;
    struct CsayChunk* next;
} CsayChunk;

typedef struct CsayRegion {
    CsayChunk* chunks;
    struct CsayRegion* prev;
} CsayRegion;

static CsayRegion* csay_region_top = NULL;

/* 保守垃圾回收：只管理非区域分配；区域内的块仍由区域整块释放。 */
typedef struct CsayGCBlock {
    int64_t size;
    int64_t mark;
    struct CsayGCBlock* next;
} CsayGCBlock;

typedef struct {
    void* p;
    int64_t n;
} CsayGCRoot;

static CsayGCBlock* csay_gc_blocks = NULL;
static CsayGCBlock** csay_gc_index = NULL;
static int64_t csay_gc_index_count = 0;
static int64_t csay_gc_block_count = 0;
static int64_t csay_gc_bytes = 0;
static int64_t csay_gc_threshold = 8 * 1024 * 1024;
static char* csay_gc_stack_bottom = NULL;
static int csay_gc_running = 0;
static CsayGCRoot* csay_gc_roots = NULL;
static int64_t csay_gc_root_count = 0;
static int64_t csay_gc_root_cap = 0;

static void csay_gc_add_root(void* p, int64_t n) {
    if (csay_gc_root_count == csay_gc_root_cap) {
        int64_t cap = csay_gc_root_cap == 0 ? 64 : csay_gc_root_cap * 2;
        CsayGCRoot* next = (CsayGCRoot*)realloc(csay_gc_roots, (size_t)(cap * (int64_t)sizeof(CsayGCRoot)));
        if (next == NULL) return;
        csay_gc_roots = next;
        csay_gc_root_cap = cap;
    }
    csay_gc_roots[csay_gc_root_count].p = p;
    csay_gc_roots[csay_gc_root_count].n = n;
    csay_gc_root_count++;
}

static void csay_gc_init(void* bottom) {
    csay_gc_stack_bottom = (char*)bottom;
}

static void csay_gc_mark_block(CsayGCBlock* b);

static int csay_gc_cmp_block(const void* a, const void* b) {
    char* da = (char*)(*(CsayGCBlock* const*)a + 1);
    char* db = (char*)(*(CsayGCBlock* const*)b + 1);
    return da < db ? -1 : (da > db ? 1 : 0);
}

static void csay_gc_mark_ptr(uintptr_t p) {
    if (p == 0 || csay_gc_index_count == 0) return;
    int64_t lo = 0, hi = csay_gc_index_count;
    while (lo < hi) {
        int64_t mid = lo + (hi - lo) / 2;
        CsayGCBlock* b = csay_gc_index[mid];
        char* data = (char*)(b + 1);
        if (p < (uintptr_t)data) {
            hi = mid;
        } else if (p >= (uintptr_t)(data + b->size)) {
            lo = mid + 1;
        } else {
            csay_gc_mark_block(b);
            return;
        }
    }
}

static void csay_gc_mark_block(CsayGCBlock* b) {
    if (b->mark) return;
    b->mark = 1;
    char* data = (char*)(b + 1);
    for (int64_t i = 0; i + 8 <= b->size; i += 8) {
        uintptr_t v;
        memcpy(&v, data + i, sizeof v);
        csay_gc_mark_ptr(v);
    }
}

static void csay_gc_mark_range(char* a, char* b) {
    if (a > b) { char* t = a; a = b; b = t; }
    uintptr_t start = ((uintptr_t)a + 7) & ~(uintptr_t)7;
    for (char* q = (char*)start; q + 8 <= b; q += 8) {
        uintptr_t v;
        memcpy(&v, q, sizeof v);
        csay_gc_mark_ptr(v);
    }
}

static void csay_gc_collect(void) {
    if (csay_gc_stack_bottom == NULL || csay_gc_running) return;
    /* 区域活动期间，GC 块可能只被区域内存引用，暂不回收。 */
    if (csay_region_top != NULL) return;
    csay_gc_running = 1;

    csay_gc_index = (CsayGCBlock**)realloc(csay_gc_index, (size_t)(csay_gc_block_count * (int64_t)sizeof(CsayGCBlock*)));
    if (csay_gc_index == NULL) {
        csay_gc_threshold = csay_gc_bytes * 2 + 4 * 1024 * 1024;
        csay_gc_running = 0;
        return;
    }
    int64_t index_count = 0;
    for (CsayGCBlock* b = csay_gc_blocks; b != NULL; b = b->next) {
        csay_gc_index[index_count++] = b;
    }
    csay_gc_index_count = index_count;
    qsort(csay_gc_index, (size_t)index_count, sizeof(CsayGCBlock*), csay_gc_cmp_block);

    for (int64_t i = 0; i < csay_gc_root_count; i++) {
        char* p = (char*)csay_gc_roots[i].p;
        csay_gc_mark_range(p, p + csay_gc_roots[i].n);
    }

    jmp_buf regs;
    memset(&regs, 0, sizeof regs);
    setjmp(regs);
    csay_gc_mark_range((char*)&regs, (char*)&regs + (int64_t)sizeof regs);

    char marker = 0;
    char* here = (char*)&marker;
    csay_gc_mark_range(here, csay_gc_stack_bottom);

    CsayGCBlock** link = &csay_gc_blocks;
    while (*link != NULL) {
        CsayGCBlock* b = *link;
        if (b->mark) {
            b->mark = 0;
            link = &b->next;
        } else {
            *link = b->next;
            csay_gc_block_count--;
            csay_gc_bytes -= b->size;
            free(b);
        }
    }

    csay_gc_index_count = 0;
    csay_gc_threshold = csay_gc_bytes * 2 + 4 * 1024 * 1024;
    csay_gc_running = 0;
}

static void* csay_gc_alloc(int64_t n) {
    if (csay_gc_stack_bottom != NULL && !csay_gc_running &&
        csay_gc_bytes + n > csay_gc_threshold) {
        csay_gc_collect();
    }
    CsayGCBlock* b = (CsayGCBlock*)malloc((size_t)((int64_t)sizeof(CsayGCBlock) + n));
    if (b == NULL) return NULL;
    b->size = n;
    b->mark = 0;
    b->next = csay_gc_blocks;
    csay_gc_blocks = b;
    csay_gc_block_count++;
    csay_gc_bytes += n;
    return (void*)(b + 1);
}

static void* csay_alloc(int64_t n) {
    n = (n + 7) & ~7LL;
    if (n <= 0) n = 8;
    if (csay_region_top == NULL) return csay_gc_alloc(n);
    CsayChunk* c = csay_region_top->chunks;
    if (c == NULL || c->used + n > c->cap) {
        int64_t cap = 4096;
        while (cap < n) cap *= 2;
        CsayChunk* nc = (CsayChunk*)malloc(sizeof(CsayChunk));
        nc->mem = (char*)malloc((size_t)cap);
        nc->used = 0;
        nc->cap = cap;
        nc->next = csay_region_top->chunks;
        csay_region_top->chunks = nc;
        c = nc;
    }
    char* p = c->mem + c->used;
    c->used += n;
    return (void*)p;
}

static void* csay_array_alloc(int64_t n, int64_t elem) {
    CsayArrayHead* h = (CsayArrayHead*)csay_alloc((int64_t)sizeof(CsayArrayHead) + n * elem);
    h->len = n;
    h->elem = elem;
    return (void*)(h + 1);
}

static int64_t csay_array_len(const void* p) {
    if (p == NULL) return 0;
    return ((const CsayArrayHead*)p)[-1].len;
}

static int64_t csay_array_elem(const void* p) {
    if (p == NULL) return 0;
    return ((const CsayArrayHead*)p)[-1].elem;
}

static void csay_array_append(void** pp, int64_t* len, int64_t elem, const void* v) {
    int64_t n = *len;
    void* p = csay_array_alloc(n + 1, elem);
    if (n > 0) memcpy(p, *pp, (size_t)(n * elem));
    memcpy((char*)p + n * elem, v, (size_t)elem);
    *pp = p;
    *len = n + 1;
}

static void csay_array_insert(void** pp, int64_t* len, int64_t elem, int64_t at, const void* v) {
    int64_t n = *len;
    if (at < 0) at = 0;
    if (at > n) at = n;
    void* p = csay_array_alloc(n + 1, elem);
    if (at > 0) memcpy(p, *pp, (size_t)(at * elem));
    memcpy((char*)p + at * elem, v, (size_t)elem);
    if (at < n) memcpy((char*)p + (at + 1) * elem, (char*)*pp + at * elem, (size_t)((n - at) * elem));
    *pp = p;
    *len = n + 1;
}

static void csay_array_remove(void** pp, int64_t* len, int64_t elem, int64_t at) {
    int64_t n = *len;
    if (at < 0 || at >= n) return;
    if (n == 1) {
        *pp = NULL;
        *len = 0;
        return;
    }
    int64_t left = at;
    int64_t right = n - at - 1;
    void* p = csay_array_alloc(n - 1, elem);
    if (left > 0) memcpy(p, *pp, (size_t)(left * elem));
    if (right > 0) memcpy((char*)p + left * elem, (char*)*pp + (at + 1) * elem, (size_t)(right * elem));
    *pp = p;
    *len = n - 1;
}

static CsayRegion* csay_region_begin(void) {
    CsayRegion* r = (CsayRegion*)malloc(sizeof(CsayRegion));
    r->chunks = NULL;
    r->prev = csay_region_top;
    csay_region_top = r;
    return r;
}

static void csay_region_end(CsayRegion* r) {
    csay_region_top = r->prev;
    CsayChunk* c = r->chunks;
    while (c != NULL) {
        CsayChunk* next = c->next;
        free(c->mem);
        free(c);
        c = next;
    }
    free(r);
}


/* ---------------- 输出 ---------------- */

static void csay_println_int(CsayInt v) { printf("%lld\n", (long long)v); }
static void csay_println_float32(CsayFloat32 v) {
    if (v == (CsayFloat32)(long long)v) printf("%lld\n", (long long)v);
    else printf("%g\n", (double)v);
}
static void csay_println_float(CsayFloat v) {
    if (v == (CsayFloat)(long long)v) printf("%lld\n", (long long)v);
    else printf("%g\n", v);
}
static void csay_println_bool(CsayBool v) { printf("%s\n", v ? "\xE7\x9C\x9F" : "\xE5\x81\x87"); }
static void csay_println_str(CsayStr s) {
    if (s.n > 0) fwrite(s.p, 1, (size_t)s.n, stdout);
    fputc('\n', stdout);
}

/* ---------------- 文本 ---------------- */

static CsayStr csay_cat(CsayStr a, CsayStr b) {
    int64_t n = a.n + b.n;
    char* p = (char*)csay_alloc(n + 1);
    if (a.n > 0) memcpy(p, a.p, (size_t)a.n);
    if (b.n > 0) memcpy(p + a.n, b.p, (size_t)b.n);
    p[n] = 0;
    return csay_str(p, n);
}

static CsayStr csay_str_of_int(CsayInt v) {
    char buf[32];
    int n = snprintf(buf, sizeof buf, "%lld", (long long)v);
    char* p = (char*)csay_alloc(n + 1);
    memcpy(p, buf, (size_t)n + 1);
    return csay_str(p, n);
}

static CsayStr csay_str_of_float32(CsayFloat32 v) {
    char buf[64];
    int n;
    if (v == (CsayFloat32)(long long)v) n = snprintf(buf, sizeof buf, "%lld", (long long)v);
    else n = snprintf(buf, sizeof buf, "%.7g", (double)v);
    char* p = (char*)csay_alloc(n + 1);
    memcpy(p, buf, (size_t)n + 1);
    return csay_str(p, n);
}

static CsayStr csay_str_of_float(CsayFloat v) {
    char buf[64];
    int n;
    if (v == (CsayFloat)(long long)v) n = snprintf(buf, sizeof buf, "%lld", (long long)v);
    else n = snprintf(buf, sizeof buf, "%g", v);
    char* p = (char*)csay_alloc(n + 1);
    memcpy(p, buf, (size_t)n + 1);
    return csay_str(p, n);
}

static CsayStr csay_str_of_bool(CsayBool v) {
    return v ? csay_str("\xE7\x9C\x9F", 3) : csay_str("\xE5\x81\x87", 3);
}

static CsayBool csay_str_eq(CsayStr a, CsayStr b) {
    return a.n == b.n && (a.n == 0 || memcmp(a.p, b.p, (size_t)a.n) == 0);
}

/* Windows 的 fopen 按 ANSI 编码解释路径，中文路径会失败。
   这里把 UTF-8 转成 UTF-16 走 _wfopen，Linux 下直接用 fopen。 */
#ifdef _WIN32
static int csay_utf8_to_wide(const char* s, wchar_t* out, int cap) {
    int n = MultiByteToWideChar(65001, 0, s, -1, NULL, 0);
    if (n <= 0 || n > cap) return 0;
    return MultiByteToWideChar(65001, 0, s, -1, out, cap) > 0;
}

static CsayStr csay_wide_to_utf8(const wchar_t* w) {
    int bytes = WideCharToMultiByte(65001, 0, w, -1, NULL, 0, NULL, NULL);
    if (bytes <= 1) return csay_lit("");
    char* p = (char*)csay_alloc(bytes);
    WideCharToMultiByte(65001, 0, w, -1, p, bytes, NULL, NULL);
    return csay_str(p, bytes - 1);
}
#endif

static FILE *csay_fopen_utf8(const char *path, const char *mode) {
#ifdef _WIN32
    wchar_t wpath[4096];
    wchar_t wmode[8];
    if (!csay_utf8_to_wide(path, wpath, 4096)) return NULL;
    int k = 0;
    while (mode[k] != 0 && k < 7) { wmode[k] = (wchar_t)mode[k]; k++; }
    wmode[k] = 0;
    return _wfopen(wpath, wmode);
#else
    return fopen(path, mode);
#endif
}

static CsayStr csay_read_file(CsayStr path) {
    char* name = (char*)malloc((size_t)path.n + 1);
    memcpy(name, path.p, (size_t)path.n);
    name[path.n] = 0;
    FILE* f = csay_fopen_utf8(name, "rb");
    free(name);
    if (f == NULL) {
        csay_throw_error(csay_error(csay_str("\xE8\xAF\xBB\xE4\xB8\x8D\xE5\x88\xB0\xE6\x96\x87\xE4\xBB\xB6", 15), CSAY_ERR_FILE));
        return csay_str("", 0);
    }
    fseek(f, 0, SEEK_END);
    long len = ftell(f);
    fseek(f, 0, SEEK_SET);
    char* buf = (char*)csay_alloc(len + 1);
    size_t got = fread(buf, 1, (size_t)len, f);
    fclose(f);
    buf[got] = 0;
    return csay_str(buf, (int64_t)got);
}

/* 把 CsayStr 复制成以 0 结尾的 C 字符串，供 getenv/stat/system 使用 */
static char* csay_cstr(CsayStr s) {
    char* p = (char*)malloc((size_t)s.n + 1);
    if (s.n > 0) memcpy(p, s.p, (size_t)s.n);
    p[s.n] = 0;
    return p;
}

static CsayStr csay_str_copy_c(const char* p) {
    int64_t n = (int64_t)strlen(p);
    char* q = (char*)csay_alloc(n + 1);
    memcpy(q, p, (size_t)n + 1);
    return csay_str(q, n);
}

static CsayInt csay_parse_time_fail(void) {
    csay_throw_error(csay_error(csay_lit("时间格式应为 YYYY-MM-DD[ HH:MM:SS][Z|±HH:MM]"), CSAY_ERR_FORMAT));
    return 0;
}

static CsayInt csay_parse_time(CsayStr s) {
    if (s.n <= 0 || s.n >= 64) return csay_parse_time_fail();
    char buf[64];
    memcpy(buf, s.p, (size_t)s.n);
    buf[s.n] = 0;
    int pos = 0;
    int y = 0, mo = 0, d = 0, h = 0, mi = 0, se = 0;
    int offset = 0;
    int got = sscanf(buf, "%d-%d-%d%n", &y, &mo, &d, &pos);
    if (got != 3) return csay_parse_time_fail();
    if (buf[pos] == 'T' || buf[pos] == ' ') {
        int start = pos + 1;
        int used = 0;
        int gotTime = sscanf(buf + start, "%d:%d:%d%n", &h, &mi, &se, &used);
        if (gotTime != 3) return csay_parse_time_fail();
        pos = start + used;
    }
    while (buf[pos] == ' ') pos++;
    if (buf[pos] == 'Z') {
        pos++;
    } else if (buf[pos] == '+' || buf[pos] == '-') {
        int sign = buf[pos] == '-' ? -1 : 1;
        int oh = 0, om = 0, used = 0;
        pos++;
        if (sscanf(buf + pos, "%d:%d%n", &oh, &om, &used) != 2) {
            used = 0;
            if (sscanf(buf + pos, "%2d%2d%n", &oh, &om, &used) != 2) return csay_parse_time_fail();
        }
        if (oh < 0 || oh > 23 || om < 0 || om > 59) return csay_parse_time_fail();
        offset = sign * (oh * 3600 + om * 60);
        pos += used;
    }
    if (buf[pos] != 0) return csay_parse_time_fail();
    if (y < 1 || y > 9999 || mo < 1 || mo > 12 || d < 1) return csay_parse_time_fail();
    int leap = (y % 4 == 0 && y % 100 != 0) || y % 400 == 0;
    int mdays[12] = { 31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31 };
    if (leap) mdays[1] = 29;
    if (d > mdays[mo - 1]) return csay_parse_time_fail();
    if (h < 0 || h > 23 || mi < 0 || mi > 59 || se < 0 || se > 59) return csay_parse_time_fail();
    int yy = y - (mo <= 2 ? 1 : 0);
    int era = (yy >= 0 ? yy : yy - 399) / 400;
    int yoe = yy - era * 400;
    int doy = (153 * (mo + (mo > 2 ? -3 : 9)) + 2) / 5 + d - 1;
    int doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    int64_t days = (int64_t)era * 146097 + doe - 719468;
    return days * 86400 + h * 3600 + mi * 60 + se - offset;
}

static CsayInt csay_timestamp(void) {
    return (CsayInt)time(NULL);
}

static CsayStr csay_format_time_zone_fail(void) {
    csay_throw_error(csay_error(csay_lit("时区格式应为 UTC、本地或 ±HH:MM"), CSAY_ERR_FORMAT));
    return csay_lit("");
}

static CsayStr csay_format_tm(struct tm* tm, CsayStr format) {
    if (tm == NULL) return csay_lit("");
    char fmt[128];
    int64_t n = format.n < 127 ? format.n : 127;
    if (n > 0) memcpy(fmt, format.p, (size_t)n);
    fmt[n] = 0;
    char buf[512];
    size_t got = strftime(buf, sizeof buf, fmt, tm);
    return csay_str_copy_c(got > 0 ? buf : "");
}

static CsayStr csay_format_time(CsayInt seconds, CsayStr format) {
    time_t t = (time_t)seconds;
    struct tm* tm = localtime(&t);
    return csay_format_tm(tm, format);
}

static CsayStr csay_localized_time(CsayInt seconds, CsayStr style) {
    time_t t = (time_t)seconds;
    struct tm* tm = localtime(&t);
    if (tm == NULL) return csay_lit("");
    static const char* weekdays[] = {
        "星期日", "星期一", "星期二", "星期三", "星期四", "星期五", "星期六"
    };
    char buf[256];
    if (csay_str_eq(style, csay_lit("短"))) {
        strftime(buf, sizeof buf, "%Y/%m/%d", tm);
    } else if (csay_str_eq(style, csay_lit("时间"))) {
        strftime(buf, sizeof buf, "%H:%M:%S", tm);
    } else if (csay_str_eq(style, csay_lit("星期"))) {
        return csay_str_copy_c(weekdays[tm->tm_wday]);
    } else if (csay_str_eq(style, csay_lit("英文"))) {
        strftime(buf, sizeof buf, "%A, %B %d, %Y %H:%M:%S", tm);
    } else {
        snprintf(buf, sizeof buf, "%04d年%02d月%02d日 %s %02d:%02d:%02d",
            tm->tm_year + 1900, tm->tm_mon + 1, tm->tm_mday,
            weekdays[tm->tm_wday], tm->tm_hour, tm->tm_min, tm->tm_sec);
    }
    return csay_str_copy_c(buf);
}

static int64_t csay_days_from_civil(int y, int m, int d) {
    y -= m <= 2;
    const int era = (y >= 0 ? y : y - 399) / 400;
    const unsigned yoe = (unsigned)(y - era * 400);
    const unsigned doy = (153 * (m + (m > 2 ? -3 : 9)) + 2) / 5 + d - 1;
    const unsigned doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    return (int64_t)era * 146097 + (int64_t)doe - 719468;
}

static int csay_weekday_of(int y, int m, int d) {
    int64_t days = csay_days_from_civil(y, m, d);
    int wd = (int)((days + 4) % 7);
    return wd < 0 ? wd + 7 : wd;
}

static int csay_nth_weekday(int y, int m, int wd, int n) {
    int first = csay_weekday_of(y, m, 1);
    return 1 + (wd - first + 7) % 7 + (n - 1) * 7;
}

static int csay_last_weekday(int y, int m, int wd) {
    static const int dim[12] = { 31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31 };
    int d = dim[m - 1];
    if (m == 2 && (y % 4 == 0 && (y % 100 != 0 || y % 400 == 0))) d = 29;
    int last = csay_weekday_of(y, m, d);
    return d - (last - wd + 7) % 7;
}

static int64_t csay_utc_seconds(int y, int m, int d, int h) {
    return csay_days_from_civil(y, m, d) * 86400 + (int64_t)h * 3600;
}

static int csay_zone_dst(CsayStr zone, CsayInt seconds) {
    time_t t = (time_t)seconds;
    struct tm* tm = gmtime(&t);
    int y = tm->tm_year + 1900;
    if (csay_str_eq(zone, csay_lit("America/New_York")) || csay_str_eq(zone, csay_lit("America/Chicago")) || csay_str_eq(zone, csay_lit("America/Denver")) || csay_str_eq(zone, csay_lit("America/Los_Angeles")) || csay_str_eq(zone, csay_lit("America/Toronto")) || csay_str_eq(zone, csay_lit("America/Vancouver")) || csay_str_eq(zone, csay_lit("America/Anchorage")) || csay_str_eq(zone, csay_lit("America/Halifax")) || csay_str_eq(zone, csay_lit("America/St_Johns")) || csay_str_eq(zone, csay_lit("America/Detroit")) || csay_str_eq(zone, csay_lit("America/Edmonton")) || csay_str_eq(zone, csay_lit("America/Winnipeg")) || csay_str_eq(zone, csay_lit("America/Havana"))) {
        int64_t start = csay_utc_seconds(y, 3, csay_nth_weekday(y, 3, 0, 2), 7);
        int64_t end = csay_utc_seconds(y, 11, csay_nth_weekday(y, 11, 0, 1), 6);
        return seconds >= start && seconds < end;
    }
    if (csay_str_eq(zone, csay_lit("Europe/London")) || csay_str_eq(zone, csay_lit("Europe/Paris")) || csay_str_eq(zone, csay_lit("Europe/Berlin")) || csay_str_eq(zone, csay_lit("Europe/Madrid")) || csay_str_eq(zone, csay_lit("Europe/Rome")) || csay_str_eq(zone, csay_lit("Europe/Amsterdam")) || csay_str_eq(zone, csay_lit("Europe/Brussels")) || csay_str_eq(zone, csay_lit("Europe/Vienna")) || csay_str_eq(zone, csay_lit("Europe/Stockholm")) || csay_str_eq(zone, csay_lit("Europe/Warsaw")) || csay_str_eq(zone, csay_lit("Europe/Lisbon")) || csay_str_eq(zone, csay_lit("Europe/Zurich")) || csay_str_eq(zone, csay_lit("Europe/Athens")) || csay_str_eq(zone, csay_lit("Europe/Helsinki")) || csay_str_eq(zone, csay_lit("Europe/Kyiv")) || csay_str_eq(zone, csay_lit("Europe/Bucharest")) || csay_str_eq(zone, csay_lit("Europe/Sofia"))) {
        int64_t start = csay_utc_seconds(y, 3, csay_last_weekday(y, 3, 0), 1);
        int64_t end = csay_utc_seconds(y, 10, csay_last_weekday(y, 10, 0), 1);
        return seconds >= start && seconds < end;
    }
    if (csay_str_eq(zone, csay_lit("Australia/Sydney"))) {
        int64_t start = csay_utc_seconds(y, 10, csay_nth_weekday(y, 10, 0, 1), 16) - 86400;
        int64_t end = csay_utc_seconds(y, 4, csay_nth_weekday(y, 4, 0, 1), 16) - 86400;
        return seconds >= start || seconds < end;
    }
    if (csay_str_eq(zone, csay_lit("Pacific/Auckland"))) {
        int64_t start = csay_utc_seconds(y, 9, csay_last_weekday(y, 9, 0), 14) - 86400;
        int64_t end = csay_utc_seconds(y, 4, csay_nth_weekday(y, 4, 0, 1), 14) - 86400;
        return seconds >= start || seconds < end;
    }
    return 0;
}

static CsayStr csay_format_time_zone(CsayInt seconds, CsayStr format, CsayStr zone) {
    if (zone.n == 0 || csay_str_eq(zone, csay_lit("本地")) || csay_str_eq(zone, csay_lit("local"))) {
        return csay_format_time(seconds, format);
    }
    int offset = 0;
    int named = 1;
    if (csay_str_eq(zone, csay_lit("UTC")) || csay_str_eq(zone, csay_lit("Z")) || csay_str_eq(zone, csay_lit("Etc/UTC"))) {
        offset = 0;
    } else if (csay_str_eq(zone, csay_lit("Asia/Shanghai")) || csay_str_eq(zone, csay_lit("Asia/Hong_Kong")) || csay_str_eq(zone, csay_lit("Asia/Singapore"))) {
        offset = 8 * 3600;
    } else if (csay_str_eq(zone, csay_lit("Asia/Tokyo")) || csay_str_eq(zone, csay_lit("Asia/Seoul"))) {
        offset = 9 * 3600;
    } else if (csay_str_eq(zone, csay_lit("Asia/Kolkata"))) {
        offset = 5 * 3600 + 1800;
    } else if (csay_str_eq(zone, csay_lit("Asia/Kathmandu"))) {
        offset = 5 * 3600 + 2700;
    } else if (csay_str_eq(zone, csay_lit("Australia/Perth"))) {
        offset = 8 * 3600;
    } else if (csay_str_eq(zone, csay_lit("Pacific/Honolulu"))) {
        offset = -10 * 3600;
    } else if (csay_str_eq(zone, csay_lit("Europe/London")) || csay_str_eq(zone, csay_lit("Europe/Lisbon"))) {
        offset = csay_zone_dst(zone, seconds) ? 3600 : 0;
    } else if (csay_str_eq(zone, csay_lit("Europe/Paris")) || csay_str_eq(zone, csay_lit("Europe/Berlin")) || csay_str_eq(zone, csay_lit("Europe/Madrid")) || csay_str_eq(zone, csay_lit("Europe/Rome")) || csay_str_eq(zone, csay_lit("Europe/Amsterdam")) || csay_str_eq(zone, csay_lit("Europe/Brussels")) || csay_str_eq(zone, csay_lit("Europe/Vienna")) || csay_str_eq(zone, csay_lit("Europe/Stockholm")) || csay_str_eq(zone, csay_lit("Europe/Warsaw")) || csay_str_eq(zone, csay_lit("Europe/Zurich"))) {
        offset = (csay_zone_dst(zone, seconds) ? 2 : 1) * 3600;
    } else if (csay_str_eq(zone, csay_lit("Europe/Athens")) || csay_str_eq(zone, csay_lit("Europe/Helsinki")) || csay_str_eq(zone, csay_lit("Europe/Kyiv")) || csay_str_eq(zone, csay_lit("Europe/Bucharest")) || csay_str_eq(zone, csay_lit("Europe/Sofia"))) {
        offset = (csay_zone_dst(zone, seconds) ? 3 : 2) * 3600;
    } else if (csay_str_eq(zone, csay_lit("Europe/Moscow"))) {
        offset = 3 * 3600;
    } else if (csay_str_eq(zone, csay_lit("America/New_York")) || csay_str_eq(zone, csay_lit("America/Toronto")) || csay_str_eq(zone, csay_lit("America/Detroit")) || csay_str_eq(zone, csay_lit("America/Havana"))) {
        offset = (csay_zone_dst(zone, seconds) ? -4 : -5) * 3600;
    } else if (csay_str_eq(zone, csay_lit("America/Chicago")) || csay_str_eq(zone, csay_lit("America/Winnipeg"))) {
        offset = (csay_zone_dst(zone, seconds) ? -5 : -6) * 3600;
    } else if (csay_str_eq(zone, csay_lit("America/Denver")) || csay_str_eq(zone, csay_lit("America/Edmonton"))) {
        offset = (csay_zone_dst(zone, seconds) ? -6 : -7) * 3600;
    } else if (csay_str_eq(zone, csay_lit("America/Los_Angeles")) || csay_str_eq(zone, csay_lit("America/Vancouver"))) {
        offset = (csay_zone_dst(zone, seconds) ? -7 : -8) * 3600;
    } else if (csay_str_eq(zone, csay_lit("America/Anchorage"))) {
        offset = (csay_zone_dst(zone, seconds) ? -8 : -9) * 3600;
    } else if (csay_str_eq(zone, csay_lit("America/Halifax"))) {
        offset = (csay_zone_dst(zone, seconds) ? -3 : -4) * 3600;
    } else if (csay_str_eq(zone, csay_lit("America/St_Johns"))) {
        offset = csay_zone_dst(zone, seconds) ? -(2 * 3600 + 1800) : -(3 * 3600 + 1800);
    } else if (csay_str_eq(zone, csay_lit("America/Phoenix"))) {
        offset = -7 * 3600;
    } else if (csay_str_eq(zone, csay_lit("America/Mexico_City"))) {
        offset = -6 * 3600;
    } else if (csay_str_eq(zone, csay_lit("America/Sao_Paulo"))) {
        offset = -3 * 3600;
    } else if (csay_str_eq(zone, csay_lit("Asia/Dubai"))) {
        offset = 4 * 3600;
    } else if (csay_str_eq(zone, csay_lit("Asia/Karachi"))) {
        offset = 5 * 3600;
    } else if (csay_str_eq(zone, csay_lit("Asia/Dhaka"))) {
        offset = 6 * 3600;
    } else if (csay_str_eq(zone, csay_lit("Asia/Yangon"))) {
        offset = 6 * 3600 + 1800;
    } else if (csay_str_eq(zone, csay_lit("Asia/Bangkok")) || csay_str_eq(zone, csay_lit("Asia/Jakarta"))) {
        offset = 7 * 3600;
    } else if (csay_str_eq(zone, csay_lit("Asia/Manila")) || csay_str_eq(zone, csay_lit("Asia/Kuala_Lumpur")) || csay_str_eq(zone, csay_lit("Asia/Taipei"))) {
        offset = 8 * 3600;
    } else if (csay_str_eq(zone, csay_lit("Africa/Johannesburg"))) {
        offset = 2 * 3600;
    } else if (csay_str_eq(zone, csay_lit("America/Bogota"))) {
        offset = -5 * 3600;
    } else if (csay_str_eq(zone, csay_lit("Europe/Istanbul"))) {
        offset = 3 * 3600;
    } else if (csay_str_eq(zone, csay_lit("Australia/Sydney"))) {
        offset = (csay_zone_dst(zone, seconds) ? 11 : 10) * 3600;
    } else if (csay_str_eq(zone, csay_lit("Pacific/Auckland"))) {
        offset = (csay_zone_dst(zone, seconds) ? 13 : 12) * 3600;
    } else {
        named = 0;
    }
    if (!named) {
        if (zone.n <= 0 || zone.n >= 16) return csay_format_time_zone_fail();
        char z[16];
        memcpy(z, zone.p, (size_t)zone.n);
        z[zone.n] = 0;
        int sign = z[0] == '-' ? -1 : 1;
        if (z[0] != '+' && z[0] != '-') return csay_format_time_zone_fail();
        int oh = 0, om = 0, used = 0;
        if (sscanf(z + 1, "%d:%d%n", &oh, &om, &used) != 2) {
            used = 0;
            if (sscanf(z + 1, "%2d%2d%n", &oh, &om, &used) != 2) return csay_format_time_zone_fail();
        }
        if (z[1 + used] != 0 || oh < 0 || oh > 23 || om < 0 || om > 59) return csay_format_time_zone_fail();
        offset = sign * (oh * 3600 + om * 60);
    }
    time_t t = (time_t)(seconds + offset);
    return csay_format_tm(gmtime(&t), format);
}

static CsayStr csay_now(void) {
    return csay_format_time(csay_timestamp(), csay_lit("%Y-%m-%d %H:%M:%S"));
}

static CsayStr csay_today(void) {
    return csay_format_time(csay_timestamp(), csay_lit("%Y-%m-%d"));
}

static CsayStr csay_current_dir(void) {
    char buf[4096];
#ifdef _WIN32
    if (_getcwd(buf, sizeof buf) == NULL) return csay_lit("");
#else
    if (getcwd(buf, sizeof buf) == NULL) return csay_lit("");
#endif
    return csay_str_copy_c(buf);
}

static CsayStr csay_path_join(CsayStr a, CsayStr b) {
    if (a.n == 0) return b;
    if (b.n == 0) return a;
    char sep = '/';
#ifdef _WIN32
    sep = '\\';
#endif
    int64_t cut = a.n;
    while (cut > 0 && (a.p[cut - 1] == '/' || a.p[cut - 1] == '\\')) cut--;
    CsayStr head = csay_str(a.p, cut);
    char* p = (char*)csay_alloc(head.n + 1 + b.n + 1);
    if (head.n > 0) memcpy(p, head.p, (size_t)head.n);
    p[head.n] = sep;
    memcpy(p + head.n + 1, b.p, (size_t)b.n);
    p[head.n + 1 + b.n] = 0;
    return csay_str(p, head.n + 1 + b.n);
}

#ifdef _WIN32
__declspec(dllimport) unsigned long __stdcall GetFileAttributesW(const wchar_t* path);
#endif

static CsayBool csay_path_exists(CsayStr path) {
    char* p = csay_cstr(path);
#ifdef _WIN32
    wchar_t w[4096];
    CsayBool ok = csay_utf8_to_wide(p, w, 4096) && GetFileAttributesW(w) != 0xFFFFFFFFu;
#else
    struct stat st;
    CsayBool ok = stat(p, &st) == 0;
#endif
    free(p);
    return ok;
}

static CsayBool csay_is_dir(CsayStr path) {
    char* p = csay_cstr(path);
#ifdef _WIN32
    wchar_t w[4096];
    unsigned long a = csay_utf8_to_wide(p, w, 4096) ? GetFileAttributesW(w) : 0xFFFFFFFFu;
    CsayBool ok = a != 0xFFFFFFFFu && (a & 0x10u) != 0;
#else
    struct stat st;
    CsayBool ok = stat(p, &st) == 0 && S_ISDIR(st.st_mode);
#endif
    free(p);
    return ok;
}

static CsayBool csay_is_file(CsayStr path) {
    char* p = csay_cstr(path);
#ifdef _WIN32
    wchar_t w[4096];
    unsigned long a = csay_utf8_to_wide(p, w, 4096) ? GetFileAttributesW(w) : 0xFFFFFFFFu;
    CsayBool ok = a != 0xFFFFFFFFu && (a & 0x10u) == 0;
#else
    struct stat st;
    CsayBool ok = stat(p, &st) == 0 && S_ISREG(st.st_mode);
#endif
    free(p);
    return ok;
}

static CsayInt csay_file_size(CsayStr path) {
    char* p = csay_cstr(path);
#ifdef _WIN32
    wchar_t w[4096];
    if (!csay_utf8_to_wide(p, w, 4096)) { free(p); return -1; }
    struct _wfinddatai64_t fd;
    intptr_t h = _wfindfirsti64(w, &fd);
    free(p);
    if (h == -1 || (fd.attrib & 0x10u) != 0) return -1;
    CsayInt size = (CsayInt)fd.size;
    _findclose(h);
    return size;
#else
    struct stat st;
    CsayInt size = stat(p, &st) == 0 && S_ISREG(st.st_mode) ? (CsayInt)st.st_size : -1;
    free(p);
    return size;
#endif
}

static CsayBool csay_make_dir(CsayStr path) {
    char* p = csay_cstr(path);
#ifdef _WIN32
    wchar_t w[4096];
    CsayBool ok = csay_utf8_to_wide(p, w, 4096) && _wmkdir(w) == 0;
#else
    CsayBool ok = mkdir(p, 0755) == 0;
#endif
    free(p);
    return ok;
}

static CsayBool csay_remove_file(CsayStr path) {
    char* p = csay_cstr(path);
#ifdef _WIN32
    wchar_t w[4096];
    CsayBool ok = csay_utf8_to_wide(p, w, 4096) && _wremove(w) == 0;
#else
    CsayBool ok = remove(p) == 0;
#endif
    free(p);
    return ok;
}

static CsayBool csay_remove_dir(CsayStr path) {
    char* p = csay_cstr(path);
#ifdef _WIN32
    wchar_t w[4096];
    CsayBool ok = csay_utf8_to_wide(p, w, 4096) && _wrmdir(w) == 0;
#else
    CsayBool ok = rmdir(p) == 0;
#endif
    free(p);
    return ok;
}

static CsayStr csay_getenv(CsayStr name) {
    char* p = csay_cstr(name);
    const char* v = getenv(p);
    free(p);
    if (v == NULL) return csay_lit("");
    return csay_str_copy_c(v);
}

static CsayStr csay_platform(void) {
#ifdef _WIN32
    return csay_lit("Windows");
#else
    return csay_lit("Linux");
#endif
}

static CsayInt csay_run_command(CsayStr command) {
    char* p = csay_cstr(command);
    int code = system(p);
    free(p);
    return (CsayInt)code;
}

static CsayStr csay_run_capture(CsayStr command) {
    char* p = csay_cstr(command);
#ifdef _WIN32
    FILE* f = _popen(p, "r");
#else
    FILE* f = popen(p, "r");
#endif
    free(p);
    if (f == NULL) return csay_lit("");
    int64_t cap = 4096;
    int64_t len = 0;
    char* out = (char*)csay_alloc(cap);
    for (;;) {
        if (len + 4096 + 1 > cap) {
            cap = cap * 2;
            char* bigger = (char*)csay_alloc(cap);
            memcpy(bigger, out, (size_t)len);
            out = bigger;
        }
        size_t got = fread(out + len, 1, 4096, f);
        len += (int64_t)got;
        if (got < 4096) break;
    }
#ifdef _WIN32
    _pclose(f);
#else
    pclose(f);
#endif
    out[len] = 0;
    return csay_str(out, len);
}

static CsayInt csay_utf8_len(CsayStr s) {
    CsayInt n = 0;
    for (CsayInt i = 0; i < s.n; i++) {
        if (((unsigned char)s.p[i] & 0xC0) != 0x80) n++;
    }
    return n;
}

static int csay_utf8_seq_len(unsigned char c) {
    if ((c & 0x80) == 0) return 1;
    if ((c & 0xE0) == 0xC0) return 2;
    if ((c & 0xF0) == 0xE0) return 3;
    if ((c & 0xF8) == 0xF0) return 4;
    return 1;
}

/* 按码点取一个字符，返回的是原字符串里的一片，不复制。越界返回空串。 */
static CsayStr csay_char_at(CsayStr s, CsayInt index) {
    if (index < 0) return csay_str("", 0);
    CsayInt pos = 0;
    CsayInt n = 0;
    while (pos < s.n) {
        int len = csay_utf8_seq_len((unsigned char)s.p[pos]);
        if (pos + len > s.n) len = 1;
        if (n == index) return csay_str(s.p + pos, len);
        pos += len;
        n++;
    }
    return csay_str("", 0);
}

/* 把 Unicode 码点编码成 UTF-8 文本 */
static CsayStr csay_char_of_code(CsayInt cp) {
    char* p = (char*)csay_alloc(5);
    int n = 0;
    if (cp < 0x80) {
        p[n++] = (char)cp;
    } else if (cp < 0x800) {
        p[n++] = (char)(0xC0 | (cp >> 6));
        p[n++] = (char)(0x80 | (cp & 0x3F));
    } else if (cp < 0x10000) {
        p[n++] = (char)(0xE0 | (cp >> 12));
        p[n++] = (char)(0x80 | ((cp >> 6) & 0x3F));
        p[n++] = (char)(0x80 | (cp & 0x3F));
    } else {
        p[n++] = (char)(0xF0 | (cp >> 18));
        p[n++] = (char)(0x80 | ((cp >> 12) & 0x3F));
        p[n++] = (char)(0x80 | ((cp >> 6) & 0x3F));
        p[n++] = (char)(0x80 | (cp & 0x3F));
    }
    return csay_str(p, n);
}

static void csay_exit(CsayInt code) { exit((int)code); }

/* 命令行参数：main 里赋值，跳过程序名，只留真正的参数 */
static int g_csay_argc = 0;
static char** g_csay_argv = NULL;

/* ---------------- 动态数组 ---------------- */

typedef struct {
    char* data;
    int64_t len;
    int64_t cap;
    int64_t elem;
} CsayList;

static CsayList* csay_list_new(int64_t elem) {
    CsayList* l = (CsayList*)csay_alloc((int64_t)sizeof(CsayList));
    l->len = 0;
    l->cap = 8;
    l->elem = elem;
    l->data = (char*)csay_alloc(l->cap * elem);
    return l;
}

static void csay_list_add(CsayList* l, const void* item) {
    if (l->len >= l->cap) {
        /* 区域分配不能 realloc：新开一块拷过去，旧块随区域一起回收 */
        int64_t newCap = l->cap * 2;
        char* nd = (char*)csay_alloc(newCap * l->elem);
        memcpy(nd, l->data, (size_t)(l->len * l->elem));
        l->data = nd;
        l->cap = newCap;
    }
    memcpy(l->data + l->len * l->elem, item, (size_t)l->elem);
    l->len++;
}

/* 自举编译器生成的 C 用这两个，避免为文本/整数取临时地址 */
static void csay_list_push_str(CsayList* l, CsayStr v) {
    csay_list_add(l, &v);
}

static void csay_list_push_int(CsayList* l, CsayInt v) {
    csay_list_add(l, &v);
}

static void* csay_list_at(CsayList* l, CsayInt i) {
    if (i < 0 || i >= l->len) {
        fputs("\xE4\xB8\x8B\xE6\xA0\x87\xE8\xB6\x8A\xE7\x95\x8C\n", stderr);
        exit(1);
    }
    return l->data + i * l->elem;
}

static void csay_list_insert(CsayList* l, CsayInt at, const void* item) {
    if (at < 0) at = 0;
    if (at > l->len) at = l->len;
    if (l->len >= l->cap) {
        int64_t newCap = l->cap * 2;
        char* nd = (char*)csay_alloc(newCap * l->elem);
        memcpy(nd, l->data, (size_t)(l->len * l->elem));
        l->data = nd;
        l->cap = newCap;
    }
    memmove(l->data + (at + 1) * l->elem, l->data + at * l->elem,
            (size_t)((l->len - at) * l->elem));
    memcpy(l->data + at * l->elem, item, (size_t)l->elem);
    l->len++;
}

static void csay_list_remove(CsayList* l, CsayInt at) {
    if (at < 0 || at >= l->len) {
        fputs("\xE5\x88\xA0\xE9\x99\xA4\xE4\xBD\x8D\xE7\xBD\xAE\xE8\xB6\x8A\xE7\x95\x8C\n", stderr);
        exit(1);
    }
    memmove(l->data + at * l->elem, l->data + (at + 1) * l->elem,
            (size_t)((l->len - at - 1) * l->elem));
    l->len--;
}

static void csay_list_clear(CsayList* l) {
    l->len = 0;
}

static CsayInt csay_list_index_int(CsayList* l, CsayInt v) {
    for (int64_t i = 0; i < l->len; i++) {
        if (*(CsayInt*)(l->data + i * l->elem) == v) return i;
    }
    return -1;
}

static CsayInt csay_list_index_float(CsayList* l, CsayFloat v) {
    for (int64_t i = 0; i < l->len; i++) {
        if (*(CsayFloat*)(l->data + i * l->elem) == v) return i;
    }
    return -1;
}

static CsayInt csay_list_index_float32(CsayList* l, CsayFloat32 v) {
    for (int64_t i = 0; i < l->len; i++) {
        if (*(CsayFloat32*)(l->data + i * l->elem) == v) return i;
    }
    return -1;
}

static CsayInt csay_list_index_str(CsayList* l, CsayStr v) {
    for (int64_t i = 0; i < l->len; i++) {
        if (csay_str_eq(*(CsayStr*)(l->data + i * l->elem), v)) return i;
    }
    return -1;
}

static CsayBool csay_list_add_unique_int(CsayList* l, CsayInt v) {
    if (csay_list_index_int(l, v) >= 0) return false;
    csay_list_add(l, &v);
    return true;
}

static CsayBool csay_list_add_unique_float(CsayList* l, CsayFloat v) {
    if (csay_list_index_float(l, v) >= 0) return false;
    csay_list_add(l, &v);
    return true;
}

static CsayBool csay_list_add_unique_float32(CsayList* l, CsayFloat32 v) {
    if (csay_list_index_float32(l, v) >= 0) return false;
    csay_list_add(l, &v);
    return true;
}

static CsayBool csay_list_add_unique_str(CsayList* l, CsayStr v) {
    if (csay_list_index_str(l, v) >= 0) return false;
    csay_list_add(l, &v);
    return true;
}

static CsayBool csay_list_add_unique_bool(CsayList* l, CsayBool v) {
    for (int64_t i = 0; i < l->len; i++) {
        if (*(CsayBool*)(l->data + i * l->elem) == v) return false;
    }
    csay_list_add(l, &v);
    return true;
}

static CsayInt csay_list_pop_front_int(CsayList* l) {
    if (l->len == 0) { csay_throw_error(csay_error(csay_lit("队列为空"), CSAY_ERR_INDEX)); return 0; }
    CsayInt v = *(CsayInt*)l->data;
    csay_list_remove(l, 0);
    return v;
}

static CsayInt csay_list_pop_back_int(CsayList* l) {
    if (l->len == 0) { csay_throw_error(csay_error(csay_lit("栈为空"), CSAY_ERR_INDEX)); return 0; }
    CsayInt v = *(CsayInt*)(l->data + (l->len - 1) * l->elem);
    csay_list_remove(l, l->len - 1);
    return v;
}

static CsayFloat csay_list_pop_front_float(CsayList* l) {
    if (l->len == 0) { csay_throw_error(csay_error(csay_lit("队列为空"), CSAY_ERR_INDEX)); return 0.0; }
    CsayFloat v = *(CsayFloat*)l->data;
    csay_list_remove(l, 0);
    return v;
}

static CsayFloat32 csay_list_pop_front_float32(CsayList* l) {
    if (l->len == 0) { csay_throw_error(csay_error(csay_lit("队列为空"), CSAY_ERR_INDEX)); return 0.0f; }
    CsayFloat32 v = *(CsayFloat32*)l->data;
    csay_list_remove(l, 0);
    return v;
}

static CsayFloat csay_list_pop_back_float(CsayList* l) {
    if (l->len == 0) { csay_throw_error(csay_error(csay_lit("栈为空"), CSAY_ERR_INDEX)); return 0.0; }
    CsayFloat v = *(CsayFloat*)(l->data + (l->len - 1) * l->elem);
    csay_list_remove(l, l->len - 1);
    return v;
}

static CsayFloat32 csay_list_pop_back_float32(CsayList* l) {
    if (l->len == 0) { csay_throw_error(csay_error(csay_lit("栈为空"), CSAY_ERR_INDEX)); return 0.0f; }
    CsayFloat32 v = *(CsayFloat32*)(l->data + (l->len - 1) * l->elem);
    csay_list_remove(l, l->len - 1);
    return v;
}

static CsayStr csay_list_pop_front_str(CsayList* l) {
    if (l->len == 0) { csay_throw_error(csay_error(csay_lit("队列为空"), CSAY_ERR_INDEX)); return csay_lit(""); }
    CsayStr v = *(CsayStr*)l->data;
    csay_list_remove(l, 0);
    return v;
}

static CsayStr csay_list_pop_back_str(CsayList* l) {
    if (l->len == 0) { csay_throw_error(csay_error(csay_lit("栈为空"), CSAY_ERR_INDEX)); return csay_lit(""); }
    CsayStr v = *(CsayStr*)(l->data + (l->len - 1) * l->elem);
    csay_list_remove(l, l->len - 1);
    return v;
}

static CsayBool csay_list_pop_front_bool(CsayList* l) {
    if (l->len == 0) { csay_throw_error(csay_error(csay_lit("队列为空"), CSAY_ERR_INDEX)); return false; }
    CsayBool v = *(CsayBool*)l->data;
    csay_list_remove(l, 0);
    return v;
}

static CsayBool csay_list_pop_back_bool(CsayList* l) {
    if (l->len == 0) { csay_throw_error(csay_error(csay_lit("栈为空"), CSAY_ERR_INDEX)); return false; }
    CsayBool v = *(CsayBool*)(l->data + (l->len - 1) * l->elem);
    csay_list_remove(l, l->len - 1);
    return v;
}

static int csay_cmp_int(const void* a, const void* b) {
    CsayInt x = *(const CsayInt*)a, y = *(const CsayInt*)b;
    return x < y ? -1 : (x > y ? 1 : 0);
}

static int csay_cmp_float(const void* a, const void* b) {
    CsayFloat x = *(const CsayFloat*)a, y = *(const CsayFloat*)b;
    return x < y ? -1 : (x > y ? 1 : 0);
}

static int csay_cmp_float32(const void* a, const void* b) {
    CsayFloat32 x = *(const CsayFloat32*)a, y = *(const CsayFloat32*)b;
    return x < y ? -1 : (x > y ? 1 : 0);
}

static int csay_cmp_str(const void* a, const void* b) {
    CsayStr x = *(const CsayStr*)a, y = *(const CsayStr*)b;
    int64_t n = x.n < y.n ? x.n : y.n;
    int c = n == 0 ? 0 : memcmp(x.p, y.p, (size_t)n);
    if (c != 0) return c;
    return x.n < y.n ? -1 : (x.n > y.n ? 1 : 0);
}

static void csay_list_sort(CsayList* l, int (*cmp)(const void*, const void*)) {
    if (l->len > 1) qsort(l->data, (size_t)l->len, (size_t)l->elem, cmp);
}

static CsayList* csay_list_dir(CsayStr path) {
    CsayList* l = csay_list_new((int64_t)sizeof(CsayStr));
    char* p = csay_cstr(path);
#ifdef _WIN32
    wchar_t w[4096];
    if (!csay_utf8_to_wide(p, w, 4096)) { free(p); return l; }
    free(p);
    int n = (int)wcslen(w);
    while (n > 0 && (w[n - 1] == L'/' || w[n - 1] == L'\\')) n--;
    if (n + 2 >= 4096) return l;
    w[n++] = L'\\';
    w[n++] = L'*';
    w[n] = 0;
    struct _wfinddatai64_t fd;
    intptr_t h = _wfindfirsti64(w, &fd);
    if (h == -1) return l;
    do {
        if (fd.name[0] == L'.' && (fd.name[1] == 0 || (fd.name[1] == L'.' && fd.name[2] == 0))) continue;
        CsayStr s = csay_wide_to_utf8(fd.name);
        csay_list_add(l, &s);
    } while (_wfindnexti64(h, &fd) == 0);
    _findclose(h);
#else
    DIR* d = opendir(p);
    free(p);
    if (d == NULL) return l;
    struct dirent* e;
    while ((e = readdir(d)) != NULL) {
        if (e->d_name[0] == '.' && (e->d_name[1] == 0 || (e->d_name[1] == '.' && e->d_name[2] == 0))) continue;
        CsayStr s = csay_str_copy_c(e->d_name);
        csay_list_add(l, &s);
    }
    closedir(d);
#endif
    csay_list_sort(l, csay_cmp_str);
    return l;
}

static CsayStr csay_repeat(CsayStr s, CsayInt times) {
    if (times <= 0 || s.n == 0) return csay_lit("");
    int64_t n = s.n * times;
    char* p = (char*)csay_alloc(n + 1);
    for (int64_t i = 0; i < times; i++) memcpy(p + i * s.n, s.p, (size_t)s.n);
    p[n] = 0;
    return csay_str(p, n);
}

static CsayStr csay_join(CsayList* l, CsayStr sep) {
    int64_t n = 0;
    for (int64_t i = 0; i < l->len; i++) {
        n += ((CsayStr*)csay_list_at(l, i))->n;
        if (i + 1 < l->len) n += sep.n;
    }
    char* p = (char*)csay_alloc(n + 1);
    int64_t o = 0;
    for (int64_t i = 0; i < l->len; i++) {
        if (i > 0) {
            memcpy(p + o, sep.p, (size_t)sep.n);
            o += sep.n;
        }
        CsayStr v = *(CsayStr*)csay_list_at(l, i);
        memcpy(p + o, v.p, (size_t)v.n);
        o += v.n;
    }
    p[o] = 0;
    return csay_str(p, o);
}

static CsayStr csay_format_float(CsayFloat v, CsayInt digits) {
    if (digits < 0) digits = 0;
    if (digits > 12) digits = 12;
    char buf[128];
    int n = snprintf(buf, sizeof buf, "%.*f", (int)digits, (double)v);
    char* p = (char*)csay_alloc(n + 1);
    memcpy(p, buf, (size_t)n + 1);
    return csay_str(p, n);
}

static CsayStr csay_format_text(CsayStr fmt, CsayList* args) {
    int64_t cap = fmt.n + 1;
    for (int64_t i = 0; i < args->len; i++) cap += ((CsayStr*)csay_list_at(args, i))->n;
    char* p = (char*)csay_alloc(cap);
    int64_t o = 0;
    int64_t ai = 0;
    for (int64_t i = 0; i < fmt.n; i++) {
        char c = fmt.p[i];
        if (c == '%' && i + 1 < fmt.n && fmt.p[i + 1] == '%') {
            p[o++] = '%';
            i++;
        } else if (c == '%' && i + 1 < fmt.n && fmt.p[i + 1] == 's') {
            if (ai >= args->len) {
                csay_throw_error(csay_error(csay_lit("格式化参数不足"), CSAY_ERR_ARG));
                return csay_lit("");
            }
            CsayStr v = *(CsayStr*)csay_list_at(args, ai++);
            memcpy(p + o, v.p, (size_t)v.n);
            o += v.n;
            i++;
        } else {
            p[o++] = c;
        }
    }
    if (ai < args->len) {
        csay_throw_error(csay_error(csay_lit("格式化参数过多"), CSAY_ERR_ARG));
        return csay_lit("");
    }
    p[o] = 0;
    return csay_str(p, o);
}

static CsayStr csay_fill_text(CsayStr s, CsayInt width, CsayStr fill) {
    CsayInt len = csay_utf8_len(s);
    if (width <= len || fill.n == 0) {
        char* p = (char*)csay_alloc(s.n + 1);
        memcpy(p, s.p, (size_t)s.n);
        p[s.n] = 0;
        return csay_str(p, s.n);
    }
    CsayStr pad = csay_repeat(fill, width - len);
    char* p = (char*)csay_alloc(s.n + pad.n + 1);
    memcpy(p, s.p, (size_t)s.n);
    memcpy(p + s.n, pad.p, (size_t)pad.n);
    p[s.n + pad.n] = 0;
    return csay_str(p, s.n + pad.n);
}

static CsayInt csay_find_text(CsayStr s, CsayStr sub) {
    if (sub.n == 0) return 0;
    for (int64_t i = 0; i + sub.n <= s.n; i++) {
        if (memcmp(s.p + i, sub.p, (size_t)sub.n) == 0) {
            CsayInt n = 0;
            for (int64_t j = 0; j < i; j++) {
                if (((unsigned char)s.p[j] & 0xC0) != 0x80) n++;
            }
            return n;
        }
    }
    return -1;
}

static CsayStr csay_json_text(CsayStr s) {
    char* p = (char*)csay_alloc(s.n * 6 + 3);
    int64_t o = 0;
    const char* hex = "0123456789abcdef";
    p[o++] = '"';
    for (int64_t i = 0; i < s.n; i++) {
        unsigned char c = (unsigned char)s.p[i];
        if (c == '"' || c == '\\') {
            p[o++] = '\\';
            p[o++] = (char)c;
        } else if (c == '\n') {
            p[o++] = '\\'; p[o++] = 'n';
        } else if (c == '\r') {
            p[o++] = '\\'; p[o++] = 'r';
        } else if (c == '\t') {
            p[o++] = '\\'; p[o++] = 't';
        } else if (c < 0x20) {
            p[o++] = '\\'; p[o++] = 'u'; p[o++] = '0'; p[o++] = '0';
            p[o++] = hex[c >> 4];
            p[o++] = hex[c & 15];
        } else {
            p[o++] = (char)c;
        }
    }
    p[o++] = '"';
    p[o] = 0;
    return csay_str(p, o);
}

static CsayStr csay_json_bool(CsayBool v) {
    return v ? csay_lit("true") : csay_lit("false");
}

static CsayStr csay_json_list(CsayList* l, int kind) {
    int64_t cap = 3;
    for (int64_t i = 0; i < l->len; i++) {
        if (kind == 0) cap += ((CsayStr*)csay_list_at(l, i))->n * 6 + 3;
        else cap += 80;
    }
    char* p = (char*)csay_alloc(cap);
    int64_t o = 0;
    p[o++] = '[';
    for (int64_t i = 0; i < l->len; i++) {
        if (i > 0) p[o++] = ',';
        CsayStr v;
        if (kind == 0) {
            v = csay_json_text(*(CsayStr*)csay_list_at(l, i));
        } else if (kind == 1) {
            v = csay_str_of_int(*(CsayInt*)csay_list_at(l, i));
        } else if (kind == 2) {
            v = csay_str_of_float(*(CsayFloat*)csay_list_at(l, i));
        } else if (kind == 4) {
            v = csay_str_of_float32(*(CsayFloat32*)csay_list_at(l, i));
        } else {
            v = csay_json_bool(*(CsayBool*)csay_list_at(l, i));
        }
        memcpy(p + o, v.p, (size_t)v.n);
        o += v.n;
    }
    p[o++] = ']';
    p[o] = 0;
    return csay_str(p, o);
}

static void csay_list_reverse(CsayList* l) {
    int64_t i = 0, j = l->len - 1;
    while (i < j) {
        char* a = l->data + i * l->elem;
        char* b = l->data + j * l->elem;
        for (int64_t k = 0; k < l->elem; k++) {
            char t = a[k]; a[k] = b[k]; b[k] = t;
        }
        i++;
        j--;
    }
}

static CsayList* csay_list_slice(CsayList* l, CsayInt from, CsayInt to) {
    if (from < 0) from = 0;
    if (to > l->len) to = l->len;
    if (to < from) to = from;
    CsayList* r = csay_list_new(l->elem);
    for (int64_t i = from; i < to; i++) csay_list_add(r, l->data + i * l->elem);
    return r;
}

/* 去重：保留首次出现的顺序。O(n²)，数据量不大够用 */
static void csay_list_unique_int(CsayList* l) {
    int64_t w = 0;
    for (int64_t i = 0; i < l->len; i++) {
        CsayInt v = *(CsayInt*)(l->data + i * l->elem);
        int dup = 0;
        for (int64_t j = 0; j < w; j++) {
            if (*(CsayInt*)(l->data + j * l->elem) == v) { dup = 1; break; }
        }
        if (!dup) {
            if (w != i) memcpy(l->data + w * l->elem, l->data + i * l->elem, (size_t)l->elem);
            w++;
        }
    }
    l->len = w;
}

static void csay_list_unique_float(CsayList* l) {
    int64_t w = 0;
    for (int64_t i = 0; i < l->len; i++) {
        CsayFloat v = *(CsayFloat*)(l->data + i * l->elem);
        int dup = 0;
        for (int64_t j = 0; j < w; j++) {
            if (*(CsayFloat*)(l->data + j * l->elem) == v) { dup = 1; break; }
        }
        if (!dup) {
            if (w != i) memcpy(l->data + w * l->elem, l->data + i * l->elem, (size_t)l->elem);
            w++;
        }
    }
    l->len = w;
}

static void csay_list_unique_float32(CsayList* l) {
    int64_t w = 0;
    for (int64_t i = 0; i < l->len; i++) {
        CsayFloat32 v = *(CsayFloat32*)(l->data + i * l->elem);
        int dup = 0;
        for (int64_t j = 0; j < w; j++) {
            if (*(CsayFloat32*)(l->data + j * l->elem) == v) { dup = 1; break; }
        }
        if (!dup) {
            if (w != i) memcpy(l->data + w * l->elem, l->data + i * l->elem, (size_t)l->elem);
            w++;
        }
    }
    l->len = w;
}

static void csay_list_unique_str(CsayList* l) {
    int64_t w = 0;
    for (int64_t i = 0; i < l->len; i++) {
        CsayStr v = *(CsayStr*)(l->data + i * l->elem);
        int dup = 0;
        for (int64_t j = 0; j < w; j++) {
            if (csay_str_eq(*(CsayStr*)(l->data + j * l->elem), v)) { dup = 1; break; }
        }
        if (!dup) {
            if (w != i) memcpy(l->data + w * l->elem, l->data + i * l->elem, (size_t)l->elem);
            w++;
        }
    }
    l->len = w;
}

static CsayInt csay_list_max_int(CsayList* l) {
    if (l->len == 0) { csay_throw_error(csay_error(csay_lit("列表为空"), CSAY_ERR_INDEX)); return 0; }
    CsayInt m = *(CsayInt*)l->data;
    for (int64_t i = 1; i < l->len; i++) {
        CsayInt v = *(CsayInt*)(l->data + i * l->elem);
        if (v > m) m = v;
    }
    return m;
}

static CsayFloat csay_list_max_float(CsayList* l) {
    if (l->len == 0) { csay_throw_error(csay_error(csay_lit("列表为空"), CSAY_ERR_INDEX)); return 0.0; }
    CsayFloat m = *(CsayFloat*)l->data;
    for (int64_t i = 1; i < l->len; i++) {
        CsayFloat v = *(CsayFloat*)(l->data + i * l->elem);
        if (v > m) m = v;
    }
    return m;
}

static CsayFloat32 csay_list_max_float32(CsayList* l) {
    if (l->len == 0) { csay_throw_error(csay_error(csay_lit("列表为空"), CSAY_ERR_INDEX)); return 0.0f; }
    CsayFloat32 m = *(CsayFloat32*)l->data;
    for (int64_t i = 1; i < l->len; i++) {
        CsayFloat32 v = *(CsayFloat32*)(l->data + i * l->elem);
        if (v > m) m = v;
    }
    return m;
}

static CsayStr csay_list_max_str(CsayList* l) {
    if (l->len == 0) { csay_throw_error(csay_error(csay_lit("列表为空"), CSAY_ERR_INDEX)); return csay_lit(""); }
    CsayStr m = *(CsayStr*)l->data;
    for (int64_t i = 1; i < l->len; i++) {
        CsayStr v = *(CsayStr*)(l->data + i * l->elem);
        if (csay_cmp_str(&v, &m) > 0) m = v;
    }
    return m;
}

static CsayInt csay_list_min_int(CsayList* l) {
    if (l->len == 0) { csay_throw_error(csay_error(csay_lit("列表为空"), CSAY_ERR_INDEX)); return 0; }
    CsayInt m = *(CsayInt*)l->data;
    for (int64_t i = 1; i < l->len; i++) {
        CsayInt v = *(CsayInt*)(l->data + i * l->elem);
        if (v < m) m = v;
    }
    return m;
}

static CsayFloat csay_list_min_float(CsayList* l) {
    if (l->len == 0) { csay_throw_error(csay_error(csay_lit("列表为空"), CSAY_ERR_INDEX)); return 0.0; }
    CsayFloat m = *(CsayFloat*)l->data;
    for (int64_t i = 1; i < l->len; i++) {
        CsayFloat v = *(CsayFloat*)(l->data + i * l->elem);
        if (v < m) m = v;
    }
    return m;
}

static CsayFloat32 csay_list_min_float32(CsayList* l) {
    if (l->len == 0) { csay_throw_error(csay_error(csay_lit("列表为空"), CSAY_ERR_INDEX)); return 0.0f; }
    CsayFloat32 m = *(CsayFloat32*)l->data;
    for (int64_t i = 1; i < l->len; i++) {
        CsayFloat32 v = *(CsayFloat32*)(l->data + i * l->elem);
        if (v < m) m = v;
    }
    return m;
}

static CsayStr csay_list_min_str(CsayList* l) {
    if (l->len == 0) { csay_throw_error(csay_error(csay_lit("列表为空"), CSAY_ERR_INDEX)); return csay_lit(""); }
    CsayStr m = *(CsayStr*)l->data;
    for (int64_t i = 1; i < l->len; i++) {
        CsayStr v = *(CsayStr*)(l->data + i * l->elem);
        if (csay_cmp_str(&v, &m) < 0) m = v;
    }
    return m;
}

/**
 * 把文本复制到当前区域之外。
 * 用法：区域 { 文本 t = ...; 返回 移出区域(t); }
 * 先退到外层分配器上复制，再恢复当前区域，这样区域回收后返回值仍然有效。
 */
static CsayStr csay_keep_str(CsayStr s) {
    CsayRegion* r = csay_region_top;
    csay_region_top = r == NULL ? NULL : r->prev;
    char* p = (char*)csay_alloc(s.n + 1);
    if (s.n > 0) memcpy(p, s.p, (size_t)s.n);
    p[s.n] = 0;
    csay_region_top = r;
    return csay_str(p, s.n);
}

static CsayList* csay_args(void) {
    CsayList* l = csay_list_new((int64_t)sizeof(CsayStr));
#ifdef _WIN32
    /* Windows 的 main 参数是 ANSI 编码，中文路径会乱。
       这里直接从 UTF-16 命令行重新取参数，转成 UTF-8。 */
    const wchar_t* cmd = GetCommandLineW();
    int i = 0;
    int index = 0;
    while (cmd[i] != 0) {
        while (cmd[i] == 32 || cmd[i] == 9) i++;
        if (cmd[i] == 0) break;
        wchar_t buf[2048];
        int n = 0;
        int quote = 0;
        while (cmd[i] != 0) {
            wchar_t c = cmd[i];
            if (c == 34) { quote = !quote; i++; continue; }
            if (!quote && (c == 32 || c == 9)) break;
            if (n < 2047) buf[n++] = c;
            i++;
        }
        buf[n] = 0;
        if (index > 0) {
            int bytes = WideCharToMultiByte(65001, 0, buf, n, NULL, 0, NULL, NULL);
            char* p = (char*)csay_alloc(bytes + 1);
            WideCharToMultiByte(65001, 0, buf, n, p, bytes, NULL, NULL);
            p[bytes] = 0;
            CsayStr s = csay_str(p, bytes);
            csay_list_add(l, &s);
        }
        index++;
    }
#else
    for (int i = 1; i < g_csay_argc; i++) {
        CsayStr s = csay_str(g_csay_argv[i], (int64_t)strlen(g_csay_argv[i]));
        csay_list_add(l, &s);
    }
#endif
    return l;
}

/* ---------------- 哈希表：键值类型由创建时指定 ---------------- */

typedef struct {
    char* keys;
    char* vals;
    unsigned char* used;
    int64_t cap;
    int64_t len;
    int64_t keySize;
    int64_t valSize;
    uint64_t (*hash)(const void*);
    int (*eq)(const void*, const void*);
} CsayMap;

/* 文本键 */
static uint64_t csay_hash_str(const void* p) {
    CsayStr s = *(const CsayStr*)p;
    uint64_t h = 1469598103934665603ULL;
    for (int64_t i = 0; i < s.n; i++) {
        h ^= (unsigned char)s.p[i];
        h *= 1099511628211ULL;
    }
    return h;
}
static int csay_eq_str(const void* a, const void* b) {
    return csay_str_eq(*(const CsayStr*)a, *(const CsayStr*)b);
}

/* 整数键 */
static uint64_t csay_hash_int(const void* p) {
    uint64_t x = (uint64_t)*(const CsayInt*)p;
    x ^= x >> 33;
    x *= 0xff51afd7ed558ccdULL;
    x ^= x >> 33;
    return x;
}
static int csay_eq_int(const void* a, const void* b) {
    return *(const CsayInt*)a == *(const CsayInt*)b;
}

/* 真假键 */
static uint64_t csay_hash_bool(const void* p) {
    return *(const CsayBool*)p ? 1 : 0;
}
static int csay_eq_bool(const void* a, const void* b) {
    return *(const CsayBool*)a == *(const CsayBool*)b;
}

static CsayMap* csay_map_new(int64_t keySize, int64_t valSize,
                             uint64_t (*hash)(const void*),
                             int (*eq)(const void*, const void*)) {
    CsayMap* m = (CsayMap*)csay_alloc((int64_t)sizeof(CsayMap));
    m->cap = 16;
    m->len = 0;
    m->keySize = keySize;
    m->valSize = valSize;
    m->hash = hash;
    m->eq = eq;
    m->keys = (char*)csay_alloc(16 * keySize);
    m->vals = (char*)csay_alloc(16 * valSize);
    m->used = (unsigned char*)csay_alloc(16);
    memset(m->used, 0, 16);
    return m;
}

static int64_t csay_map_probe(CsayMap* m, const void* k) {
    uint64_t h = m->hash(k) & (uint64_t)(m->cap - 1);
    for (;;) {
        if (!m->used[h]) return (int64_t)h;
        if (m->eq(m->keys + (int64_t)h * m->keySize, k)) return (int64_t)h;
        h = (h + 1) & (uint64_t)(m->cap - 1);
    }
}

static void csay_map_rehash(CsayMap* m) {
    int64_t oldCap = m->cap;
    char* oldKeys = m->keys;
    char* oldVals = m->vals;
    unsigned char* oldUsed = m->used;
    m->cap = oldCap * 2;
    m->keys = (char*)csay_alloc(m->cap * m->keySize);
    m->vals = (char*)csay_alloc(m->cap * m->valSize);
    m->used = (unsigned char*)csay_alloc(m->cap);
    memset(m->used, 0, (size_t)m->cap);
    m->len = 0;
    for (int64_t i = 0; i < oldCap; i++) {
        if (!oldUsed[i]) continue;
        int64_t h = csay_map_probe(m, oldKeys + i * m->keySize);
        memcpy(m->keys + h * m->keySize, oldKeys + i * m->keySize, (size_t)m->keySize);
        memcpy(m->vals + h * m->valSize, oldVals + i * m->valSize, (size_t)m->valSize);
        m->used[h] = 1;
        m->len++;
    }
    /* 旧表随区域一起回收，不单独 free */
}

static void csay_map_set(CsayMap* m, const void* k, const void* v) {
    if ((m->len + 1) * 4 >= m->cap * 3) csay_map_rehash(m);
    int64_t h = csay_map_probe(m, k);
    if (!m->used[h]) {
        memcpy(m->keys + h * m->keySize, k, (size_t)m->keySize);
        m->used[h] = 1;
        m->len++;
    }
    memcpy(m->vals + h * m->valSize, v, (size_t)m->valSize);
}

static void* csay_map_ptr(CsayMap* m, const void* k) {
    int64_t h = csay_map_probe(m, k);
    return m->used[h] ? m->vals + h * m->valSize : NULL;
}

static CsayBool csay_map_has(CsayMap* m, const void* k) {
    return csay_map_ptr(m, k) != NULL;
}

static void* csay_map_ptr_or(CsayMap* m, const void* k, void* def) {
    void* p = csay_map_ptr(m, k);
    return p == NULL ? def : p;
}

static CsayStr csay_map_text_or(CsayMap* m, const void* k, CsayStr def) {
    if (m == NULL) return def;
    return *(CsayStr*)csay_map_ptr_or(m, k, &def);
}

static void* csay_map_at(CsayMap* m, const void* k) {
    void* p = csay_map_ptr(m, k);
    if (p == NULL) {
        fputs("\xE8\xA1\xA8\xE9\x87\x8C\xE6\xB2\xA1\xE6\x9C\x89\xE8\xBF\x99\xE4\xB8\xAA\xE9\x94\xAE\n", stderr);
        exit(1);
    }
    return p;
}

/* 开放寻址删除要重建，否则探测链会断。这里直接整体重排一遍，O(n) 但不会错 */
static void csay_map_remove(CsayMap* m, const void* k) {
    int64_t target = csay_map_probe(m, k);
    if (!m->used[target]) return;

    int64_t oldCap = m->cap;
    char* oldK = m->keys;
    char* oldV = m->vals;
    unsigned char* oldU = m->used;

    m->keys = (char*)csay_alloc(oldCap * m->keySize);
    m->vals = (char*)csay_alloc(oldCap * m->valSize);
    m->used = (unsigned char*)csay_alloc(oldCap);
    memset(m->used, 0, (size_t)oldCap);
    m->len = 0;

    for (int64_t i = 0; i < oldCap; i++) {
        if (!oldU[i] || i == target) continue;
        int64_t h = csay_map_probe(m, oldK + i * m->keySize);
        memcpy(m->keys + h * m->keySize, oldK + i * m->keySize, (size_t)m->keySize);
        memcpy(m->vals + h * m->valSize, oldV + i * m->valSize, (size_t)m->valSize);
        m->used[h] = 1;
        m->len++;
    }
}

static CsayStr csay_json_array(const void* a, CsayInt n, int kind) {
    int64_t cap = 3;
    for (CsayInt i = 0; i < n; i++) {
        if (kind == 0) cap += ((CsayStr*)a)[i].n * 6 + 3;
        else cap += 80;
    }
    char* p = (char*)csay_alloc(cap);
    int64_t o = 0;
    p[o++] = '[';
    for (CsayInt i = 0; i < n; i++) {
        if (i > 0) p[o++] = ',';
        CsayStr v;
        if (kind == 0) v = csay_json_text(((CsayStr*)a)[i]);
        else if (kind == 1) v = csay_str_of_int(((CsayInt*)a)[i]);
        else if (kind == 2) v = csay_str_of_float(((CsayFloat*)a)[i]);
        else if (kind == 4) v = csay_str_of_float32(((CsayFloat32*)a)[i]);
        else v = csay_json_bool(((CsayBool*)a)[i]);
        memcpy(p + o, v.p, (size_t)v.n);
        o += v.n;
    }
    p[o++] = ']';
    p[o] = 0;
    return csay_str(p, o);
}

static CsayStr csay_json_map(CsayMap* m, int kind) {
    int64_t cap = 3;
    for (int64_t i = 0; i < m->cap; i++) {
        if (!m->used[i]) continue;
        CsayStr k = *(CsayStr*)(m->keys + i * m->keySize);
        cap += k.n * 6 + 3 + 48;
    }
    char* p = (char*)csay_alloc(cap);
    int64_t o = 0;
    int first = 1;
    p[o++] = '{';
    for (int64_t i = 0; i < m->cap; i++) {
        if (!m->used[i]) continue;
        CsayStr k = *(CsayStr*)(m->keys + i * m->keySize);
        CsayStr key = csay_json_text(k);
        if (!first) p[o++] = ',';
        first = 0;
        memcpy(p + o, key.p, (size_t)key.n);
        o += key.n;
        p[o++] = ':';
        void* v = m->vals + i * m->valSize;
        CsayStr val;
        if (kind == 0) val = csay_json_text(*(CsayStr*)v);
        else if (kind == 1) val = csay_str_of_int(*(CsayInt*)v);
        else if (kind == 2) val = csay_str_of_float(*(CsayFloat*)v);
        else if (kind == 4) val = csay_str_of_float32(*(CsayFloat32*)v);
        else val = csay_json_bool(*(CsayBool*)v);
        memcpy(p + o, val.p, (size_t)val.n);
        o += val.n;
    }
    p[o++] = '}';
    p[o] = 0;
    return csay_str(p, o);
}

/* 轻量正则：字面量、.、*、+、?、{m,n}、^、$、分组、分支、转义和字符类。
   字符类支持 ASCII 范围和 \d、\w、\s；分组只用于组合，不保存捕获结果。 */
#define CSAY_RE_POS_MAX 2048

typedef struct CsayReNode CsayReNode;
typedef struct {
    int* a;
    int n;
} CsayRePos;

struct CsayReNode {
    int kind;
    const char* lit;
    int litlen;
    const char* cls;
    int clslen;
    int neg;
    int min;
    int max;
    CsayReNode* a;
    CsayReNode* b;
};

enum {
    CSAY_RE_EMPTY = 0,
    CSAY_RE_SEQ,
    CSAY_RE_ALT,
    CSAY_RE_LIT,
    CSAY_RE_DOT,
    CSAY_RE_CLASS,
    CSAY_RE_GROUP,
    CSAY_RE_REPEAT,
    CSAY_RE_BOL,
    CSAY_RE_EOL
};

static int csay_re_seq(const char* p, int n, int pos) {
    if (pos < 0 || pos >= n) return 0;
    int len = csay_utf8_seq_len((unsigned char)p[pos]);
    if (len < 1) len = 1;
    if (pos + len > n) len = n - pos;
    return len;
}

static int csay_re_class_next(const char* t, int tn, int ti,
                              const char* cls, int n, int neg) {
    if (ti >= tn) return -1;
    int l = csay_re_seq(t, tn, ti);
    if (l <= 0) return -1;
    unsigned char c = (unsigned char)t[ti];
    int matched = 0;
    for (int i = 0; i < n;) {
        if (cls[i] == '\\' && i + 1 < n) {
            char e = cls[i + 1];
            i += 2;
            if (e == 'd') matched |= c >= '0' && c <= '9';
            else if (e == 'w') matched |= (c >= '0' && c <= '9') || (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || c == '_';
            else if (e == 's') matched |= c == ' ' || c == '\t' || c == '\n' || c == '\r';
            else if (e == 'D') matched |= !(c >= '0' && c <= '9');
            else if (e == 'W') matched |= !((c >= '0' && c <= '9') || (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || c == '_');
            else if (e == 'S') matched |= !(c == ' ' || c == '\t' || c == '\n' || c == '\r');
            else matched |= l == 1 && c == (unsigned char)e;
            continue;
        }
        if (l == 1 && i + 2 < n && cls[i + 1] == '-') {
            unsigned char a = (unsigned char)cls[i];
            unsigned char b = (unsigned char)cls[i + 2];
            if (c >= a && c <= b) matched = 1;
            i += 3;
            continue;
        }
        int cl = csay_re_seq(cls, n, i);
        if (cl == l && memcmp(t + ti, cls + i, (size_t)cl) == 0) matched = 1;
        i += cl;
    }
    if (neg) matched = !matched;
    return matched ? ti + l : -1;
}

static CsayReNode* csay_re_new(int kind) {
    CsayReNode* n = (CsayReNode*)csay_alloc(sizeof(CsayReNode));
    memset(n, 0, sizeof(CsayReNode));
    n->kind = kind;
    return n;
}

static CsayReNode* csay_re_parse_alt(const char* p, int n, int* pi);

static CsayReNode* csay_re_parse_seq(const char* p, int n, int* pi) {
    CsayReNode* seq = NULL;
    while (*pi < n && p[*pi] != '|' && p[*pi] != ')') {
        CsayReNode* item = NULL;
        /* 解析一个带可选数量词的原子。原子解析失败时避免死循环。 */
        int before = *pi;
        char c = p[*pi];
        if (c == '(') {
            (*pi)++;
            CsayReNode* child = csay_re_parse_alt(p, n, pi);
            if (*pi < n && p[*pi] == ')') (*pi)++;
            item = csay_re_new(CSAY_RE_GROUP);
            item->a = child;
        } else if (c == '[') {
            int j = *pi + 1;
            int neg = 0;
            if (j < n && p[j] == '^') { neg = 1; j++; }
            int content = j;
            while (j < n && p[j] != ']') {
                if (p[j] == '\\' && j + 1 < n) j += 2;
                else j += csay_re_seq(p, n, j);
            }
            if (j < n) {
                item = csay_re_new(CSAY_RE_CLASS);
                item->cls = p + content;
                item->clslen = j - content;
                item->neg = neg;
                *pi = j + 1;
            }
        } else if (c == '\\') {
            if (*pi + 1 >= n) {
                item = csay_re_new(CSAY_RE_LIT);
                item->lit = p + *pi;
                item->litlen = 1;
                (*pi)++;
            } else {
                char e = p[*pi + 1];
                if (e == 'd' || e == 'D' || e == 'w' || e == 'W' || e == 's' || e == 'S') {
                    item = csay_re_new(CSAY_RE_CLASS);
                    item->cls = p + *pi;
                    item->clslen = 2;
                    *pi += 2;
                } else {
                    int l = csay_re_seq(p, n, *pi + 1);
                    item = csay_re_new(CSAY_RE_LIT);
                    item->lit = p + *pi + 1;
                    item->litlen = l;
                    *pi += 1 + l;
                }
            }
        } else if (c == '.') {
            item = csay_re_new(CSAY_RE_DOT);
            (*pi)++;
        } else if (c == '^') {
            item = csay_re_new(CSAY_RE_BOL);
            (*pi)++;
        } else if (c == '$') {
            item = csay_re_new(CSAY_RE_EOL);
            (*pi)++;
        } else if (c == '|' || c == ')') {
            break;
        } else {
            int l = csay_re_seq(p, n, *pi);
            item = csay_re_new(CSAY_RE_LIT);
            item->lit = p + *pi;
            item->litlen = l;
            *pi += l;
        }
        if (*pi == before) break;
        if (item == NULL) break;
        if (*pi < n && (p[*pi] == '*' || p[*pi] == '+' || p[*pi] == '?' || p[*pi] == '{')) {
            int lo = 0, hi = 0;
            int valid = 1;
            if (p[*pi] == '*') { lo = 0; hi = -1; (*pi)++; }
            else if (p[*pi] == '+') { lo = 1; hi = -1; (*pi)++; }
            else if (p[*pi] == '?') { lo = 0; hi = 1; (*pi)++; }
            else {
                int save = *pi;
                (*pi)++;
                if (*pi >= n || p[*pi] < '0' || p[*pi] > '9') {
                    *pi = save;
                    valid = 0;
                } else {
                    lo = 0;
                    while (*pi < n && p[*pi] >= '0' && p[*pi] <= '9') {
                        lo = lo * 10 + (p[*pi] - '0');
                        (*pi)++;
                    }
                    hi = lo;
                    if (*pi < n && p[*pi] == ',') {
                        (*pi)++;
                        if (*pi < n && p[*pi] >= '0' && p[*pi] <= '9') {
                            hi = 0;
                            while (*pi < n && p[*pi] >= '0' && p[*pi] <= '9') {
                                hi = hi * 10 + (p[*pi] - '0');
                                (*pi)++;
                            }
                        } else {
                            hi = -1;
                        }
                    }
                    if (*pi >= n || p[*pi] != '}' || (hi >= 0 && hi < lo)) {
                        *pi = save;
                        valid = 0;
                    } else {
                        (*pi)++;
                    }
                }
            }
            if (valid) {
                CsayReNode* rep = csay_re_new(CSAY_RE_REPEAT);
                rep->a = item;
                rep->min = lo;
                rep->max = hi;
                item = rep;
            }
        }
        if (!seq) seq = item;
        else {
            CsayReNode* s = csay_re_new(CSAY_RE_SEQ);
            s->a = seq;
            s->b = item;
            seq = s;
        }
    }
    if (!seq) return csay_re_new(CSAY_RE_EMPTY);
    return seq;
}

static CsayReNode* csay_re_parse_alt(const char* p, int n, int* pi) {
    CsayReNode* left = csay_re_parse_seq(p, n, pi);
    while (*pi < n && p[*pi] == '|') {
        (*pi)++;
        CsayReNode* right = csay_re_parse_seq(p, n, pi);
        CsayReNode* node = csay_re_new(CSAY_RE_ALT);
        node->a = left;
        node->b = right;
        left = node;
    }
    return left;
}

static void csay_re_pos_push(CsayRePos* r, int v) {
    if (r->n >= CSAY_RE_POS_MAX) return;
    for (int i = 0; i < r->n; i++) if (r->a[i] == v) return;
    r->a[r->n++] = v;
}

static void csay_re_pos_init(CsayRePos* r) {
    r->a = (int*)csay_alloc(sizeof(int) * CSAY_RE_POS_MAX);
    r->n = 0;
}

static void csay_re_positions(CsayReNode* node, const char* t, int tn, int ti, CsayRePos* out);

static void csay_re_positions_repeat(CsayReNode* node, const char* t, int tn, int ti, CsayRePos* out) {
    if (node->min > 2048) return;
    if (node->max < 0) {
        int max = 256;
        if (node->min > max) max = node->min;
        CsayRePos* levels = (CsayRePos*)csay_alloc(sizeof(CsayRePos) * (max + 1));
        csay_re_pos_init(&levels[0]);
        csay_re_pos_push(&levels[0], ti);
        int last = 0;
        for (int k = 1; k <= max; k++) {
            CsayRePos next;
            csay_re_pos_init(&next);
            for (int i = 0; i < levels[last].n; i++) {
                CsayRePos tmp;
                csay_re_pos_init(&tmp);
                csay_re_positions(node->a, t, tn, levels[last].a[i], &tmp);
                for (int j = 0; j < tmp.n; j++) csay_re_pos_push(&next, tmp.a[j]);
            }
            if (next.n == 0) break;
            levels[k] = next;
            last = k;
            /* 空匹配的重复不再产生新位置。 */
            int same = next.n == levels[k - 1].n;
            for (int i = 0; same && i < next.n; i++) if (next.a[i] != levels[k - 1].a[i]) same = 0;
            if (same) {
                if (node->min > last) {
                    for (int i = 0; i < levels[last].n; i++) csay_re_pos_push(out, levels[last].a[i]);
                }
                break;
            }
        }
        for (int k = last; k >= node->min; k--) {
            for (int i = 0; i < levels[k].n; i++) csay_re_pos_push(out, levels[k].a[i]);
        }
        if (node->min == 0) csay_re_pos_push(out, ti);
        return;
    }
    int max = node->max;
    if (max > 2048) max = 2048;
    CsayRePos* levels = (CsayRePos*)csay_alloc(sizeof(CsayRePos) * (max + 1));
    csay_re_pos_init(&levels[0]);
    csay_re_pos_push(&levels[0], ti);
    int last = 0;
    for (int k = 1; k <= max; k++) {
        CsayRePos next;
        csay_re_pos_init(&next);
        for (int i = 0; i < levels[last].n; i++) {
            CsayRePos tmp;
            csay_re_pos_init(&tmp);
            csay_re_positions(node->a, t, tn, levels[last].a[i], &tmp);
            for (int j = 0; j < tmp.n; j++) csay_re_pos_push(&next, tmp.a[j]);
        }
        if (next.n == 0) break;
        levels[k] = next;
        last = k;
    }
    for (int k = last; k >= node->min; k--) {
        for (int i = 0; i < levels[k].n; i++) csay_re_pos_push(out, levels[k].a[i]);
    }
    if (node->min == 0) csay_re_pos_push(out, ti);
}

static void csay_re_positions(CsayReNode* node, const char* t, int tn, int ti, CsayRePos* out) {
    if (node == NULL || node->kind == CSAY_RE_EMPTY) {
        csay_re_pos_push(out, ti);
        return;
    }
    switch (node->kind) {
    case CSAY_RE_SEQ: {
        CsayRePos mid;
        csay_re_pos_init(&mid);
        csay_re_positions(node->a, t, tn, ti, &mid);
        for (int i = 0; i < mid.n; i++) {
            CsayRePos tmp;
            csay_re_pos_init(&tmp);
            csay_re_positions(node->b, t, tn, mid.a[i], &tmp);
            for (int j = 0; j < tmp.n; j++) csay_re_pos_push(out, tmp.a[j]);
        }
        return;
    }
    case CSAY_RE_ALT:
        csay_re_positions(node->a, t, tn, ti, out);
        csay_re_positions(node->b, t, tn, ti, out);
        return;
    case CSAY_RE_GROUP:
        csay_re_positions(node->a, t, tn, ti, out);
        return;
    case CSAY_RE_REPEAT:
        csay_re_positions_repeat(node, t, tn, ti, out);
        return;
    case CSAY_RE_LIT:
        if (ti + node->litlen <= tn && memcmp(t + ti, node->lit, (size_t)node->litlen) == 0) {
            csay_re_pos_push(out, ti + node->litlen);
        }
        return;
    case CSAY_RE_DOT: {
        int l = csay_re_seq(t, tn, ti);
        if (l > 0) csay_re_pos_push(out, ti + l);
        return;
    }
    case CSAY_RE_CLASS: {
        int np = csay_re_class_next(t, tn, ti, node->cls, node->clslen, node->neg);
        if (np >= 0) csay_re_pos_push(out, np);
        return;
    }
    case CSAY_RE_BOL:
        if (ti == 0) csay_re_pos_push(out, ti);
        return;
    case CSAY_RE_EOL:
        if (ti == tn) csay_re_pos_push(out, ti);
        return;
    default:
        return;
    }
}

static CsayInt csay_regex_search(CsayStr text, CsayStr pat, CsayInt* endOut) {
    CsayRegion* region = csay_region_begin();
    int pi = 0;
    CsayReNode* root = csay_re_parse_alt(pat.p, (int)pat.n, &pi);
    int start = 0;
    int found = -1;
    while (start <= text.n) {
        CsayRePos out;
        csay_re_pos_init(&out);
        csay_re_positions(root, text.p, (int)text.n, start, &out);
        if (out.n > 0) {
            *endOut = out.a[0];
            found = start;
            break;
        }
        if (start == text.n) break;
        int l = csay_re_seq(text.p, (int)text.n, start);
        start += l > 0 ? l : 1;
    }
    csay_region_end(region);
    return found;
}

static CsayBool csay_regex_match(CsayStr text, CsayStr pat) {
    CsayInt end = 0;
    return csay_regex_search(text, pat, &end) >= 0;
}

static CsayInt csay_regex_find(CsayStr text, CsayStr pat) {
    CsayInt end = 0;
    CsayInt at = csay_regex_search(text, pat, &end);
    if (at < 0) return -1;
    CsayInt n = 0;
    for (CsayInt i = 0; i < at; i++) {
        if (((unsigned char)text.p[i] & 0xC0) != 0x80) n++;
    }
    return n;
}

static CsayStr csay_regex_replace(CsayStr text, CsayStr pat, CsayStr rep) {
    CsayInt end = 0;
    CsayInt at = csay_regex_search(text, pat, &end);
    if (at < 0) {
        char* q = (char*)csay_alloc(text.n + 1);
        memcpy(q, text.p, (size_t)text.n);
        q[text.n] = 0;
        return csay_str(q, text.n);
    }
    CsayInt total = at + rep.n + (text.n - end);
    char* p = (char*)csay_alloc(total + 1);
    memcpy(p, text.p, (size_t)at);
    memcpy(p + at, rep.p, (size_t)rep.n);
    memcpy(p + at + rep.n, text.p + end, (size_t)(text.n - end));
    p[total] = 0;
    return csay_str(p, total);
}

/* ---------------- JSON：解析成一层 键 -> 文本 表 ----------------
   对象按键展开；数组键为 [0]、[1]；嵌套对象/数组保留原始 JSON 文本。
   字符串解码转义；数字保留字面量；true/false 转成 真/假；null 保留 null。 */
static const char* csay_json_p;
static const char* csay_json_end;

static void csay_json_fail(void) {
    csay_throw_error(csay_error(csay_lit("JSON 格式错误"), CSAY_ERR_FORMAT));
}

static void csay_json_ws(void) {
    while (csay_json_p < csay_json_end &&
           (*csay_json_p == ' ' || *csay_json_p == '\n' ||
            *csay_json_p == '\r' || *csay_json_p == '\t')) {
        csay_json_p++;
    }
}

static CsayStr csay_json_span(const char* a, const char* b) {
    int64_t n = (int64_t)(b - a);
    char* q = (char*)csay_alloc(n + 1);
    memcpy(q, a, (size_t)n);
    q[n] = 0;
    return csay_str(q, n);
}

static int csay_json_hex(char c) {
    if (c >= '0' && c <= '9') return c - '0';
    if (c >= 'a' && c <= 'f') return c - 'a' + 10;
    if (c >= 'A' && c <= 'F') return c - 'A' + 10;
    return -1;
}

static void csay_json_utf8(char* out, int64_t* n, unsigned cp) {
    if (cp <= 0x7F) {
        out[(*n)++] = (char)cp;
    } else if (cp <= 0x7FF) {
        out[(*n)++] = (char)(0xC0 | (cp >> 6));
        out[(*n)++] = (char)(0x80 | (cp & 0x3F));
    } else if (cp <= 0xFFFF) {
        out[(*n)++] = (char)(0xE0 | (cp >> 12));
        out[(*n)++] = (char)(0x80 | ((cp >> 6) & 0x3F));
        out[(*n)++] = (char)(0x80 | (cp & 0x3F));
    } else {
        out[(*n)++] = (char)(0xF0 | (cp >> 18));
        out[(*n)++] = (char)(0x80 | ((cp >> 12) & 0x3F));
        out[(*n)++] = (char)(0x80 | ((cp >> 6) & 0x3F));
        out[(*n)++] = (char)(0x80 | (cp & 0x3F));
    }
}

static CsayStr csay_json_string(void) {
    if (csay_json_p >= csay_json_end || *csay_json_p != '"') {
        csay_json_fail();
        return csay_lit("");
    }
    csay_json_p++;
    char* buf = (char*)csay_alloc((csay_json_end - csay_json_p) * 4 + 1);
    int64_t n = 0;
    while (csay_json_p < csay_json_end) {
        unsigned char c = (unsigned char)*csay_json_p++;
        if (c == '"') {
            buf[n] = 0;
            return csay_str(buf, n);
        }
        if (c == '\\') {
            if (csay_json_p >= csay_json_end) { csay_json_fail(); return csay_lit(""); }
            char esc = *csay_json_p++;
            if (esc == '"' || esc == '\\' || esc == '/') {
                buf[n++] = esc;
            } else if (esc == 'b') {
                buf[n++] = '\b';
            } else if (esc == 'f') {
                buf[n++] = '\f';
            } else if (esc == 'n') {
                buf[n++] = '\n';
            } else if (esc == 'r') {
                buf[n++] = '\r';
            } else if (esc == 't') {
                buf[n++] = '\t';
            } else if (esc == 'u') {
                unsigned cp = 0;
                for (int k = 0; k < 4; k++) {
                    if (csay_json_p >= csay_json_end) { csay_json_fail(); return csay_lit(""); }
                    int h = csay_json_hex(*csay_json_p++);
                    if (h < 0) { csay_json_fail(); return csay_lit(""); }
                    cp = cp * 16 + (unsigned)h;
                }
                if (cp >= 0xD800 && cp <= 0xDBFF &&
                    csay_json_p + 5 < csay_json_end &&
                    csay_json_p[0] == '\\' && csay_json_p[1] == 'u') {
                    unsigned lo = 0;
                    csay_json_p += 2;
                    for (int k = 0; k < 4; k++) {
                        int h = csay_json_hex(*csay_json_p++);
                        if (h < 0) { csay_json_fail(); return csay_lit(""); }
                        lo = lo * 16 + (unsigned)h;
                    }
                    if (lo >= 0xDC00 && lo <= 0xDFFF) {
                        cp = 0x10000 + ((cp - 0xD800) << 10) + (lo - 0xDC00);
                    } else {
                        csay_json_fail();
                        return csay_lit("");
                    }
                }
                csay_json_utf8(buf, &n, cp);
            } else {
                csay_json_fail();
                return csay_lit("");
            }
        } else {
            if (c < 0x20) { csay_json_fail(); return csay_lit(""); }
            buf[n++] = (char)c;
        }
    }
    csay_json_fail();
    return csay_lit("");
}

static void csay_json_skip_value(void);

static CsayStr csay_json_scalar(void) {
    if (csay_json_p >= csay_json_end) { csay_json_fail(); return csay_lit(""); }
    char c = *csay_json_p;
    if (c == '"') return csay_json_string();
    if (c == 't' && csay_json_end - csay_json_p >= 4 &&
        memcmp(csay_json_p, "true", 4) == 0) {
        csay_json_p += 4;
        return csay_str_of_bool(1);
    }
    if (c == 'f' && csay_json_end - csay_json_p >= 5 &&
        memcmp(csay_json_p, "false", 5) == 0) {
        csay_json_p += 5;
        return csay_str_of_bool(0);
    }
    if (c == 'n' && csay_json_end - csay_json_p >= 4 &&
        memcmp(csay_json_p, "null", 4) == 0) {
        csay_json_p += 4;
        return csay_lit("null");
    }
    const char* start = csay_json_p;
    if (c == '-') csay_json_p++;
    int digits = 0;
    while (csay_json_p < csay_json_end &&
           *csay_json_p >= '0' && *csay_json_p <= '9') {
        csay_json_p++;
        digits++;
    }
    if (digits == 0) { csay_json_fail(); return csay_lit(""); }
    if (csay_json_p < csay_json_end && *csay_json_p == '.') {
        csay_json_p++;
        int frac = 0;
        while (csay_json_p < csay_json_end &&
               *csay_json_p >= '0' && *csay_json_p <= '9') {
            csay_json_p++;
            frac++;
        }
        if (frac == 0) { csay_json_fail(); return csay_lit(""); }
    }
    if (csay_json_p < csay_json_end &&
        (*csay_json_p == 'e' || *csay_json_p == 'E')) {
        csay_json_p++;
        if (csay_json_p < csay_json_end &&
            (*csay_json_p == '+' || *csay_json_p == '-')) csay_json_p++;
        int exp = 0;
        while (csay_json_p < csay_json_end &&
               *csay_json_p >= '0' && *csay_json_p <= '9') {
            csay_json_p++;
            exp++;
        }
        if (exp == 0) { csay_json_fail(); return csay_lit(""); }
    }
    if (csay_json_p == start) { csay_json_fail(); return csay_lit(""); }
    return csay_json_span(start, csay_json_p);
}

static void csay_json_skip_value(void) {
    csay_json_ws();
    if (csay_json_p >= csay_json_end) { csay_json_fail(); return; }
    char c = *csay_json_p;
    if (c == '{' || c == '[') {
        char open = c;
        char close = c == '{' ? '}' : ']';
        csay_json_p++;
        csay_json_ws();
        if (csay_json_p < csay_json_end && *csay_json_p == close) {
            csay_json_p++;
            return;
        }
        for (;;) {
            csay_json_ws();
            if (open == '{') {
                csay_json_string();
                csay_json_ws();
                if (csay_json_p >= csay_json_end || *csay_json_p != ':') { csay_json_fail(); return; }
                csay_json_p++;
            }
            csay_json_skip_value();
            csay_json_ws();
            if (csay_json_p < csay_json_end && *csay_json_p == ',') {
                csay_json_p++;
                continue;
            }
            if (csay_json_p < csay_json_end && *csay_json_p == close) {
                csay_json_p++;
                return;
            }
            csay_json_fail();
            return;
        }
    }
    if (c == '"') { csay_json_string(); return; }
    if (c == 't' && csay_json_end - csay_json_p >= 4 &&
        memcmp(csay_json_p, "true", 4) == 0) { csay_json_p += 4; return; }
    if (c == 'f' && csay_json_end - csay_json_p >= 5 &&
        memcmp(csay_json_p, "false", 5) == 0) { csay_json_p += 5; return; }
    if (c == 'n' && csay_json_end - csay_json_p >= 4 &&
        memcmp(csay_json_p, "null", 4) == 0) { csay_json_p += 4; return; }
    csay_json_scalar();
}

static void csay_json_parse_object(CsayMap* m) {
    csay_json_p++;
    csay_json_ws();
    if (csay_json_p < csay_json_end && *csay_json_p == '}') { csay_json_p++; return; }
    for (;;) {
        CsayStr k = csay_json_string();
        csay_json_ws();
        if (csay_json_p >= csay_json_end || *csay_json_p != ':') { csay_json_fail(); return; }
        csay_json_p++;
        csay_json_ws();
        const char* start = csay_json_p;
        CsayStr v;
        if (csay_json_p < csay_json_end &&
            (*csay_json_p == '{' || *csay_json_p == '[')) {
            csay_json_skip_value();
            v = csay_json_span(start, csay_json_p);
        } else {
            v = csay_json_scalar();
        }
        csay_map_set(m, &k, &v);
        csay_json_ws();
        if (csay_json_p < csay_json_end && *csay_json_p == ',') {
            csay_json_p++;
            csay_json_ws();
            continue;
        }
        if (csay_json_p < csay_json_end && *csay_json_p == '}') {
            csay_json_p++;
            return;
        }
        csay_json_fail();
        return;
    }
}

static void csay_json_parse_array(CsayMap* m) {
    csay_json_p++;
    csay_json_ws();
    if (csay_json_p < csay_json_end && *csay_json_p == ']') { csay_json_p++; return; }
    int64_t index = 0;
    for (;;) {
        char kb[32];
        int kn = snprintf(kb, sizeof kb, "[%lld]", (long long)index);
        CsayStr k = csay_json_span(kb, kb + kn);
        csay_json_ws();
        const char* start = csay_json_p;
        CsayStr v;
        if (csay_json_p < csay_json_end &&
            (*csay_json_p == '{' || *csay_json_p == '[')) {
            csay_json_skip_value();
            v = csay_json_span(start, csay_json_p);
        } else {
            v = csay_json_scalar();
        }
        csay_map_set(m, &k, &v);
        index++;
        csay_json_ws();
        if (csay_json_p < csay_json_end && *csay_json_p == ',') {
            csay_json_p++;
            continue;
        }
        if (csay_json_p < csay_json_end && *csay_json_p == ']') {
            csay_json_p++;
            return;
        }
        csay_json_fail();
        return;
    }
}

static CsayMap* csay_json_parse(CsayStr s) {
    csay_json_p = s.p;
    csay_json_end = s.p + s.n;
    csay_json_ws();
    CsayMap* m = csay_map_new((int64_t)sizeof(CsayStr), (int64_t)sizeof(CsayStr),
                              csay_hash_str, csay_eq_str);
    if (csay_json_p < csay_json_end && *csay_json_p == '{') {
        csay_json_parse_object(m);
    } else if (csay_json_p < csay_json_end && *csay_json_p == '[') {
        csay_json_parse_array(m);
    } else {
        csay_json_fail();
    }
    csay_json_ws();
    if (csay_json_p != csay_json_end) csay_json_fail();
    return m;
}

static void csay_json_path_fail(void) {
    csay_throw_error(csay_error(csay_lit("JSON 路径不存在"), CSAY_ERR_FORMAT));
}

/* 按 a.b[0].c 读取嵌套值；返回字符串解码后的文本，对象/数组返回原始 JSON。 */
static CsayStr csay_json_get(CsayStr s, CsayStr path) {
    if (path.n == 0) return s;
    CsayStr cur = s;
    int64_t i = 0;
    while (i < path.n) {
        CsayStr key;
        if (path.p[i] == '[') {
            int64_t start = i;
            i++;
            if (i >= path.n || path.p[i] < '0' || path.p[i] > '9') {
                csay_json_path_fail();
                return csay_lit("");
            }
            while (i < path.n && path.p[i] >= '0' && path.p[i] <= '9') i++;
            if (i >= path.n || path.p[i] != ']') {
                csay_json_path_fail();
                return csay_lit("");
            }
            i++;
            key = csay_json_span(path.p + start, path.p + i);
        } else {
            int64_t start = i;
            while (i < path.n && path.p[i] != '.' && path.p[i] != '[') i++;
            if (i == start) {
                csay_json_path_fail();
                return csay_lit("");
            }
            key = csay_json_span(path.p + start, path.p + i);
        }
        CsayMap* m = csay_json_parse(cur);
        CsayStr* slot = (CsayStr*)csay_map_ptr(m, &key);
        if (slot == NULL) {
            csay_json_path_fail();
            return csay_lit("");
        }
        cur = *slot;
        if (i < path.n) {
            if (path.p[i] == '.') {
                i++;
                if (i >= path.n) {
                    csay_json_path_fail();
                    return csay_lit("");
                }
            } else if (path.p[i] != '[') {
                csay_json_path_fail();
                return csay_lit("");
            }
        }
    }
    return cur;
}

/* 解析路径的一段。at 指向段首，返回时指向下一段，或 path.n。 */
static void csay_json_path_next(CsayStr path, int64_t* at, CsayStr* key, int* is_index, int64_t* index) {
    int64_t i = *at;
    if (i >= path.n) csay_json_path_fail();
    if (path.p[i] == '[') {
        i++;
        if (i >= path.n || path.p[i] < '0' || path.p[i] > '9') {
            csay_json_path_fail();
            return;
        }
        int64_t n = 0;
        while (i < path.n && path.p[i] >= '0' && path.p[i] <= '9') {
            n = n * 10 + (path.p[i] - '0');
            if (n > 1000000000) { csay_json_path_fail(); return; }
            i++;
        }
        if (i >= path.n || path.p[i] != ']') {
            csay_json_path_fail();
            return;
        }
        i++;
        *is_index = 1;
        *index = n;
        *key = csay_lit("");
    } else {
        int64_t start = i;
        while (i < path.n && path.p[i] != '.' && path.p[i] != '[') i++;
        if (i == start) {
            csay_json_path_fail();
            return;
        }
        *key = csay_json_span(path.p + start, path.p + i);
        *is_index = 0;
        *index = 0;
    }
    if (i < path.n) {
        if (path.p[i] == '.') {
            i++;
            if (i >= path.n) { csay_json_path_fail(); return; }
        } else if (path.p[i] != '[') {
            csay_json_path_fail();
            return;
        }
    }
    *at = i;
}

/* 在 JSON 文本的一层对象或数组里找到某个键/下标对应的原始值范围。 */
static int csay_json_find_value(CsayStr s, CsayStr key, int is_index, int64_t index,
                                const char** vstart, const char** vend) {
    csay_json_p = s.p;
    csay_json_end = s.p + s.n;
    csay_json_ws();
    if (is_index) {
        if (csay_json_p >= csay_json_end || *csay_json_p != '[') return 0;
        csay_json_p++;
        csay_json_ws();
        if (csay_json_p < csay_json_end && *csay_json_p == ']') return 0;
        int64_t n = 0;
        for (;;) {
            csay_json_ws();
            const char* a = csay_json_p;
            csay_json_skip_value();
            const char* b = csay_json_p;
            if (n == index) {
                *vstart = a;
                *vend = b;
                return 1;
            }
            n++;
            csay_json_ws();
            if (csay_json_p < csay_json_end && *csay_json_p == ',') {
                csay_json_p++;
                continue;
            }
            if (csay_json_p < csay_json_end && *csay_json_p == ']') return 0;
            csay_json_fail();
            return 0;
        }
    }
    if (csay_json_p >= csay_json_end || *csay_json_p != '{') return 0;
    csay_json_p++;
    csay_json_ws();
    if (csay_json_p < csay_json_end && *csay_json_p == '}') return 0;
    for (;;) {
        CsayStr k = csay_json_string();
        csay_json_ws();
        if (csay_json_p >= csay_json_end || *csay_json_p != ':') {
            csay_json_fail();
            return 0;
        }
        csay_json_p++;
        csay_json_ws();
        const char* a = csay_json_p;
        csay_json_skip_value();
        const char* b = csay_json_p;
        if (k.n == key.n && memcmp(k.p, key.p, (size_t)k.n) == 0) {
            *vstart = a;
            *vend = b;
            return 1;
        }
        csay_json_ws();
        if (csay_json_p < csay_json_end && *csay_json_p == ',') {
            csay_json_p++;
            csay_json_ws();
            continue;
        }
        if (csay_json_p < csay_json_end && *csay_json_p == '}') return 0;
        csay_json_fail();
        return 0;
    }
}

static CsayStr csay_json_splice(CsayStr s, const char* a, const char* b, CsayStr value) {
    int64_t pre = (int64_t)(a - s.p);
    int64_t post = (int64_t)((s.p + s.n) - b);
    int64_t n = pre + value.n + post;
    char* q = (char*)csay_alloc(n + 1);
    memcpy(q, s.p, (size_t)pre);
    memcpy(q + pre, value.p, (size_t)value.n);
    memcpy(q + pre + value.n, b, (size_t)post);
    q[n] = 0;
    return csay_str(q, n);
}

static CsayStr csay_json_set_at(CsayStr s, CsayStr path, int64_t at, CsayStr value) {
    if (at >= path.n) return value;
    CsayStr key;
    int is_index = 0;
    int64_t index = 0;
    csay_json_path_next(path, &at, &key, &is_index, &index);
    const char* a = NULL;
    const char* b = NULL;
    if (!csay_json_find_value(s, key, is_index, index, &a, &b)) {
        csay_json_path_fail();
        return csay_lit("");
    }
    CsayStr child = csay_json_span(a, b);
    CsayStr repl = at < path.n ? csay_json_set_at(child, path, at, value) : value;
    return csay_json_splice(s, a, b, repl);
}

/* 替换路径上的值；新值必须是合法 JSON 文本，例如 文本 要带引号。 */
static CsayStr csay_json_set(CsayStr s, CsayStr path, CsayStr value) {
    return csay_json_set_at(s, path, 0, value);
}

/* 条目遍历：每个 键×值 组合一份结构和一个遍历函数 */

typedef struct { CsayStr key; CsayInt val; } CsayEntry_文本_整数;
typedef struct { CsayStr key; CsayFloat32 val; } CsayEntry_文本_浮点数;
typedef struct { CsayStr key; CsayFloat val; } CsayEntry_文本_长小数;
typedef struct { CsayStr key; CsayStr val; } CsayEntry_文本_文本;
typedef struct { CsayStr key; CsayBool val; } CsayEntry_文本_真假;
typedef struct { CsayInt key; CsayInt val; } CsayEntry_整数_整数;
typedef struct { CsayInt key; CsayFloat32 val; } CsayEntry_整数_浮点数;
typedef struct { CsayInt key; CsayFloat val; } CsayEntry_整数_长小数;
typedef struct { CsayInt key; CsayStr val; } CsayEntry_整数_文本;
typedef struct { CsayInt key; CsayBool val; } CsayEntry_整数_真假;
typedef struct { CsayBool key; CsayInt val; } CsayEntry_真假_整数;
typedef struct { CsayBool key; CsayFloat32 val; } CsayEntry_真假_浮点数;
typedef struct { CsayBool key; CsayFloat val; } CsayEntry_真假_长小数;
typedef struct { CsayBool key; CsayStr val; } CsayEntry_真假_文本;
typedef struct { CsayBool key; CsayBool val; } CsayEntry_真假_真假;

static CsayList* csay_map_entries_文本_整数(CsayMap* m) {
    CsayList* l = csay_list_new((int64_t)sizeof(CsayEntry_文本_整数));
    for (int64_t i = 0; i < m->cap; i++) {
        if (!m->used[i]) continue;
        CsayEntry_文本_整数 e;
        memcpy(&e.key, m->keys + i * m->keySize, sizeof(CsayStr));
        memcpy(&e.val, m->vals + i * m->valSize, sizeof(CsayInt));
        csay_list_add(l, &e);
    }
    return l;
}

static CsayList* csay_map_entries_文本_浮点数(CsayMap* m) {
    CsayList* l = csay_list_new((int64_t)sizeof(CsayEntry_文本_浮点数));
    for (int64_t i = 0; i < m->cap; i++) {
        if (!m->used[i]) continue;
        CsayEntry_文本_浮点数 e;
        memcpy(&e.key, m->keys + i * m->keySize, sizeof(CsayStr));
        memcpy(&e.val, m->vals + i * m->valSize, sizeof(CsayFloat32));
        csay_list_add(l, &e);
    }
    return l;
}

static CsayList* csay_map_entries_文本_长小数(CsayMap* m) {
    CsayList* l = csay_list_new((int64_t)sizeof(CsayEntry_文本_长小数));
    for (int64_t i = 0; i < m->cap; i++) {
        if (!m->used[i]) continue;
        CsayEntry_文本_长小数 e;
        memcpy(&e.key, m->keys + i * m->keySize, sizeof(CsayStr));
        memcpy(&e.val, m->vals + i * m->valSize, sizeof(CsayFloat));
        csay_list_add(l, &e);
    }
    return l;
}

static CsayList* csay_map_entries_文本_文本(CsayMap* m) {
    CsayList* l = csay_list_new((int64_t)sizeof(CsayEntry_文本_文本));
    for (int64_t i = 0; i < m->cap; i++) {
        if (!m->used[i]) continue;
        CsayEntry_文本_文本 e;
        memcpy(&e.key, m->keys + i * m->keySize, sizeof(CsayStr));
        memcpy(&e.val, m->vals + i * m->valSize, sizeof(CsayStr));
        csay_list_add(l, &e);
    }
    return l;
}

static CsayList* csay_map_entries_文本_真假(CsayMap* m) {
    CsayList* l = csay_list_new((int64_t)sizeof(CsayEntry_文本_真假));
    for (int64_t i = 0; i < m->cap; i++) {
        if (!m->used[i]) continue;
        CsayEntry_文本_真假 e;
        memcpy(&e.key, m->keys + i * m->keySize, sizeof(CsayStr));
        memcpy(&e.val, m->vals + i * m->valSize, sizeof(CsayBool));
        csay_list_add(l, &e);
    }
    return l;
}

static CsayList* csay_map_entries_整数_整数(CsayMap* m) {
    CsayList* l = csay_list_new((int64_t)sizeof(CsayEntry_整数_整数));
    for (int64_t i = 0; i < m->cap; i++) {
        if (!m->used[i]) continue;
        CsayEntry_整数_整数 e;
        memcpy(&e.key, m->keys + i * m->keySize, sizeof(CsayInt));
        memcpy(&e.val, m->vals + i * m->valSize, sizeof(CsayInt));
        csay_list_add(l, &e);
    }
    return l;
}

static CsayList* csay_map_entries_整数_浮点数(CsayMap* m) {
    CsayList* l = csay_list_new((int64_t)sizeof(CsayEntry_整数_浮点数));
    for (int64_t i = 0; i < m->cap; i++) {
        if (!m->used[i]) continue;
        CsayEntry_整数_浮点数 e;
        memcpy(&e.key, m->keys + i * m->keySize, sizeof(CsayInt));
        memcpy(&e.val, m->vals + i * m->valSize, sizeof(CsayFloat32));
        csay_list_add(l, &e);
    }
    return l;
}

static CsayList* csay_map_entries_整数_长小数(CsayMap* m) {
    CsayList* l = csay_list_new((int64_t)sizeof(CsayEntry_整数_长小数));
    for (int64_t i = 0; i < m->cap; i++) {
        if (!m->used[i]) continue;
        CsayEntry_整数_长小数 e;
        memcpy(&e.key, m->keys + i * m->keySize, sizeof(CsayInt));
        memcpy(&e.val, m->vals + i * m->valSize, sizeof(CsayFloat));
        csay_list_add(l, &e);
    }
    return l;
}

static CsayList* csay_map_entries_整数_文本(CsayMap* m) {
    CsayList* l = csay_list_new((int64_t)sizeof(CsayEntry_整数_文本));
    for (int64_t i = 0; i < m->cap; i++) {
        if (!m->used[i]) continue;
        CsayEntry_整数_文本 e;
        memcpy(&e.key, m->keys + i * m->keySize, sizeof(CsayInt));
        memcpy(&e.val, m->vals + i * m->valSize, sizeof(CsayStr));
        csay_list_add(l, &e);
    }
    return l;
}

static CsayList* csay_map_entries_整数_真假(CsayMap* m) {
    CsayList* l = csay_list_new((int64_t)sizeof(CsayEntry_整数_真假));
    for (int64_t i = 0; i < m->cap; i++) {
        if (!m->used[i]) continue;
        CsayEntry_整数_真假 e;
        memcpy(&e.key, m->keys + i * m->keySize, sizeof(CsayInt));
        memcpy(&e.val, m->vals + i * m->valSize, sizeof(CsayBool));
        csay_list_add(l, &e);
    }
    return l;
}

static CsayList* csay_map_entries_真假_整数(CsayMap* m) {
    CsayList* l = csay_list_new((int64_t)sizeof(CsayEntry_真假_整数));
    for (int64_t i = 0; i < m->cap; i++) {
        if (!m->used[i]) continue;
        CsayEntry_真假_整数 e;
        memcpy(&e.key, m->keys + i * m->keySize, sizeof(CsayBool));
        memcpy(&e.val, m->vals + i * m->valSize, sizeof(CsayInt));
        csay_list_add(l, &e);
    }
    return l;
}

static CsayList* csay_map_entries_真假_浮点数(CsayMap* m) {
    CsayList* l = csay_list_new((int64_t)sizeof(CsayEntry_真假_浮点数));
    for (int64_t i = 0; i < m->cap; i++) {
        if (!m->used[i]) continue;
        CsayEntry_真假_浮点数 e;
        memcpy(&e.key, m->keys + i * m->keySize, sizeof(CsayBool));
        memcpy(&e.val, m->vals + i * m->valSize, sizeof(CsayFloat32));
        csay_list_add(l, &e);
    }
    return l;
}

static CsayList* csay_map_entries_真假_长小数(CsayMap* m) {
    CsayList* l = csay_list_new((int64_t)sizeof(CsayEntry_真假_长小数));
    for (int64_t i = 0; i < m->cap; i++) {
        if (!m->used[i]) continue;
        CsayEntry_真假_长小数 e;
        memcpy(&e.key, m->keys + i * m->keySize, sizeof(CsayBool));
        memcpy(&e.val, m->vals + i * m->valSize, sizeof(CsayFloat));
        csay_list_add(l, &e);
    }
    return l;
}

static CsayList* csay_map_entries_真假_文本(CsayMap* m) {
    CsayList* l = csay_list_new((int64_t)sizeof(CsayEntry_真假_文本));
    for (int64_t i = 0; i < m->cap; i++) {
        if (!m->used[i]) continue;
        CsayEntry_真假_文本 e;
        memcpy(&e.key, m->keys + i * m->keySize, sizeof(CsayBool));
        memcpy(&e.val, m->vals + i * m->valSize, sizeof(CsayStr));
        csay_list_add(l, &e);
    }
    return l;
}

static CsayList* csay_map_entries_真假_真假(CsayMap* m) {
    CsayList* l = csay_list_new((int64_t)sizeof(CsayEntry_真假_真假));
    for (int64_t i = 0; i < m->cap; i++) {
        if (!m->used[i]) continue;
        CsayEntry_真假_真假 e;
        memcpy(&e.key, m->keys + i * m->keySize, sizeof(CsayBool));
        memcpy(&e.val, m->vals + i * m->valSize, sizeof(CsayBool));
        csay_list_add(l, &e);
    }
    return l;
}

/* 按类型描述递归序列化。描述符只用 ASCII：
   s/i/f/d/b 基本类型，l 列表，m 表（后跟键类型 s 或 i），
   A 带长度头的数组（后跟元素描述）。 */
static CsayStr csay_json_any(const void* v, int64_t n, int64_t elem, const char* d) {
    char k = *d++;
    if (k == 's') return csay_json_text(*(const CsayStr*)v);
    if (k == 'c') return csay_json_text(csay_char_of_code(*(const CsayInt*)v));
    if (k == 'i') return csay_str_of_int(*(const CsayInt*)v);
    if (k == 'f') return csay_str_of_float32(*(const CsayFloat32*)v);
    if (k == 'd') return csay_str_of_float(*(const CsayFloat*)v);
    if (k == 'b') return csay_json_bool(*(const CsayBool*)v);
    if (k == 'a') {
        CsayStr out = csay_lit("[");
        for (int64_t i = 0; i < n; i++) {
            if (i > 0) out = csay_cat(out, csay_lit(","));
            out = csay_cat(out, csay_json_any((const char*)v + i * elem, 0, 0, d));
        }
        return csay_cat(out, csay_lit("]"));
    }
    if (k == 'A') {
        const void* p = *(void* const*)v;
        if (p == NULL) return csay_lit("[]");
        int64_t len = csay_array_len(p);
        int64_t es = csay_array_elem(p);
        CsayStr out = csay_lit("[");
        for (int64_t i = 0; i < len; i++) {
            if (i > 0) out = csay_cat(out, csay_lit(","));
            out = csay_cat(out, csay_json_any((const char*)p + i * es, 0, 0, d));
        }
        return csay_cat(out, csay_lit("]"));
    }
    if (k == 'l') {
        CsayList* l = *(CsayList* const*)v;
        if (l == NULL) return csay_lit("null");
        CsayStr out = csay_lit("[");
        for (int64_t i = 0; i < l->len; i++) {
            if (i > 0) out = csay_cat(out, csay_lit(","));
            out = csay_cat(out, csay_json_any(csay_list_at(l, i), 0, 0, d));
        }
        return csay_cat(out, csay_lit("]"));
    }
    if (k == 'm') {
        char keyKind = *d++;
        CsayMap* m = *(CsayMap* const*)v;
        if (m == NULL) return csay_lit("null");
        CsayStr out = csay_lit("{");
        int64_t written = 0;
        for (int64_t i = 0; i < m->cap; i++) {
            if (!m->used[i]) continue;
            if (written++ > 0) out = csay_cat(out, csay_lit(","));
            const void* kp = m->keys + i * m->keySize;
            CsayStr key = keyKind == 's'
                ? csay_json_text(*(const CsayStr*)kp)
                : keyKind == 'b'
                    ? csay_json_text(csay_str_of_bool(*(const CsayBool*)kp))
                    : csay_json_text(csay_str_of_int(*(const CsayInt*)kp));
            out = csay_cat(out, key);
            out = csay_cat(out, csay_lit(":"));
            out = csay_cat(out, csay_json_any(m->vals + i * m->valSize, 0, 0, d));
        }
        return csay_cat(out, csay_lit("}"));
    }
    return csay_lit("null");
}

/* ---------------- 文本切分 ---------------- */

static CsayList* csay_split(CsayStr s, CsayStr sep) {
    CsayList* l = csay_list_new((int64_t)sizeof(CsayStr));
    if (sep.n == 0) {
        /* 空分隔符按 Unicode 码点切成单个字符，自举编译器用它避免 O(n²) 下标 */
        int64_t i = 0;
        while (i < s.n) {
            int len = csay_utf8_seq_len((unsigned char)s.p[i]);
            if (i + len > s.n) len = 1;
            CsayStr part = csay_str(s.p + i, len);
            csay_list_add(l, &part);
            i += len;
        }
        return l;
    }
    int64_t start = 0;
    int64_t i = 0;
    while (i + sep.n <= s.n) {
        if (memcmp(s.p + i, sep.p, (size_t)sep.n) == 0) {
            CsayStr part = csay_str(s.p + start, i - start);
            csay_list_add(l, &part);
            i += sep.n;
            start = i;
        } else {
            i++;
        }
    }
    CsayStr last = csay_str(s.p + start, s.n - start);
    csay_list_add(l, &last);
    return l;
}

static int csay_is_space(unsigned char c) {
    return c == ' ' || c == '\t' || c == '\n' || c == '\r' || c == '\f' || c == '\v';
}

static CsayList* csay_split_ws(CsayStr s) {
    CsayList* l = csay_list_new((int64_t)sizeof(CsayStr));
    int64_t i = 0;
    while (i < s.n) {
        while (i < s.n && csay_is_space((unsigned char)s.p[i])) i++;
        if (i >= s.n) break;
        int64_t start = i;
        while (i < s.n && !csay_is_space((unsigned char)s.p[i])) i++;
        CsayStr part = csay_str(s.p + start, i - start);
        csay_list_add(l, &part);
    }
    return l;
}

/* ---------------- 异常：setjmp / longjmp ---------------- */

typedef struct CsayTry {
    jmp_buf buf;
    struct CsayTry* prev;
    CsayError err;
} CsayTry;

static CsayTry* csay_try_top = NULL;

static CsayError csay_error(CsayStr msg, CsayInt kind) {
    CsayError e;
    e.msg = msg;
    e.kind = kind;
    e.ok = 1;
    return e;
}

static CsayError csay_error_null(void) {
    CsayError e;
    e.msg = csay_lit("");
    e.kind = 0;
    e.ok = 0;
    return e;
}

static CsayError csay_error_coalesce(CsayError a, CsayError b) {
    return a.ok ? a : b;
}

static CsayInt csay_error_equal(CsayError a, CsayError b) {
    if (a.ok != b.ok) return 0;
    if (!a.ok) return 1;
    return a.kind == b.kind && csay_str_eq(a.msg, b.msg);
}

static CsayStr csay_error_kind_name(CsayInt kind) {
    if (kind == CSAY_ERR_ARG) return csay_lit("\xE5\x8F\x82\xE6\x95\xB0\xE5\xBC\x82\xE5\xB8\xB8");
    if (kind == CSAY_ERR_STATE) return csay_lit("\xE7\x8A\xB6\xE6\x80\x81\xE5\xBC\x82\xE5\xB8\xB8");
    if (kind == CSAY_ERR_FILE) return csay_lit("\xE6\x96\x87\xE4\xBB\xB6\xE5\xBC\x82\xE5\xB8\xB8");
    if (kind == CSAY_ERR_INDEX) return csay_lit("\xE8\xB6\x8A\xE7\x95\x8C\xE5\xBC\x82\xE5\xB8\xB8");
    if (kind == CSAY_ERR_FORMAT) return csay_lit("\xE6\xA0\xBC\xE5\xBC\x8F\xE5\xBC\x82\xE5\xB8\xB8");
    return csay_lit("\xE5\xBC\x82\xE5\xB8\xB8");
}

static CsayStr csay_error_ns_msg(CsayError e) {
    return e.ok ? e.msg : csay_lit("");
}

static CsayStr csay_error_ns_kind(CsayError e) {
    return e.ok ? csay_error_kind_name(e.kind) : csay_lit("");
}

static void csay_throw_error(CsayError e) {
    if (csay_try_top == NULL) {
        fputs("\xE6\x9C\xAA\xE5\xA4\x84\xE7\x90\x86\xE7\x9A\x84\xE5\xBC\x82\xE5\xB8\xB8\xEF\xBC\x9A", stderr);
        if (e.msg.n > 0) fwrite(e.msg.p, 1, (size_t)e.msg.n, stderr);
        fputc('\n', stderr);
        exit(1);
    }
    csay_try_top->err = e;
    longjmp(csay_try_top->buf, 1);
}

static void csay_throw(CsayStr msg) {
    csay_throw_error(csay_error(msg, CSAY_ERR_BASE));
}

static void csay_assert(CsayBool cond, CsayStr msg) {
    if (cond) return;
    if (msg.n == 0) msg = csay_lit("断言失败");
    csay_throw_error(csay_error(msg, CSAY_ERR_STATE));
}

/* ---------------- 其它常用库函数 ---------------- */

static CsayFloat csay_random(void) {
    return (CsayFloat)rand() / (CsayFloat)RAND_MAX;
}

static CsayInt csay_random_int(CsayInt lo, CsayInt hi) {
    if (hi < lo) { CsayInt t = lo; lo = hi; hi = t; }
    CsayInt span = hi - lo + 1;
    if (span <= 0) return lo;
    return lo + (CsayInt)(rand() % span);
}

static void csay_random_seed(CsayInt seed) {
    srand((unsigned)seed);
}
static CsayStr csay_read_line(void) {
#ifdef _WIN32
    void* h = GetStdHandle((unsigned long)-10);
    unsigned long mode = 0;
    if (h != NULL && GetConsoleMode(h, &mode)) {
        wchar_t wbuf[4096];
        unsigned long got = 0;
        if (ReadConsoleW(h, wbuf, 4095, &got, NULL)) {
            while (got > 0 && (wbuf[got - 1] == L'\n' || wbuf[got - 1] == L'\r')) got--;
            int bytes = WideCharToMultiByte(65001, 0, wbuf, (int)got, NULL, 0, NULL, NULL);
            char* p = (char*)csay_alloc(bytes + 1);
            if (bytes > 0) WideCharToMultiByte(65001, 0, wbuf, (int)got, p, bytes, NULL, NULL);
            p[bytes] = 0;
            return csay_str(p, bytes);
        }
    }
#endif
    int64_t cap = 128;
    int64_t len = 0;
    char* buf = (char*)csay_alloc(cap);
    int c;
    while ((c = fgetc(stdin)) != EOF && c != '\n') {
        if (len + 1 >= cap) {
            char* next = (char*)csay_alloc(cap * 2);
            memcpy(next, buf, (size_t)len);
            buf = next;
            cap *= 2;
        }
        buf[len++] = (char)c;
    }
    if (len > 0 && buf[len - 1] == '\r') len--;
    buf[len] = 0;
    return csay_str(buf, len);
}
/* 询问：先打印提示（不换行），再读一行输入 */
static CsayStr csay_ask(CsayStr prompt) {
    if (prompt.n > 0) {
        printf("%.*s", (int)prompt.n, prompt.p);
        fflush(stdout);
    }
    return csay_read_line();
}

static CsayStr csay_str_upper(CsayStr s) {
    CsayStr buf = csay_str((char*)csay_alloc(s.n + 1), s.n);
    char* out = (char*)buf.p;
    for (int64_t i = 0; i < s.n; i++) {
        char c = s.p[i];
        out[i] = (c >= 'a' && c <= 'z') ? (char)(c - 'a' + 'A') : c;
    }
    out[s.n] = 0;
    return buf;
}

static CsayStr csay_str_lower(CsayStr s) {
    CsayStr buf = csay_str((char*)csay_alloc(s.n + 1), s.n);
    char* out = (char*)buf.p;
    for (int64_t i = 0; i < s.n; i++) {
        char c = s.p[i];
        out[i] = (c >= 'A' && c <= 'Z') ? (char)(c - 'A' + 'a') : c;
    }
    out[s.n] = 0;
    return buf;
}

static CsayStr csay_str_trim(CsayStr s) {
    int64_t start = 0;
    int64_t end = s.n;
    while (start < end && (s.p[start] == ' ' || s.p[start] == '\t' || s.p[start] == '\r' || s.p[start] == '\n')) start++;
    while (end > start && (s.p[end - 1] == ' ' || s.p[end - 1] == '\t' || s.p[end - 1] == '\r' || s.p[end - 1] == '\n')) end--;
    return csay_str((char*)s.p + start, end - start);
}

static CsayStr csay_str_replace(CsayStr s, CsayStr from, CsayStr to) {    if (from.n == 0) return s;
    CsayStr buf = csay_str((char*)csay_alloc(s.n * 2 + 1), 0);
    char* out = (char*)buf.p;
    int64_t outLen = 0;
    int64_t i = 0;
    while (i < s.n) {
        if (i + from.n <= s.n && memcmp(s.p + i, from.p, (size_t)from.n) == 0) {
            memcpy(out + outLen, to.p, (size_t)to.n);
            outLen += to.n;
            i += from.n;
        } else {
            out[outLen++] = s.p[i++];
        }
    }
    out[outLen] = 0;
    buf.n = outLen;
    return buf;
}

static CsayBool csay_str_contains(CsayStr s, CsayStr sub) {
    if (sub.n == 0) return true;
    for (int64_t i = 0; i + sub.n <= s.n; i++) {
        if (memcmp(s.p + i, sub.p, (size_t)sub.n) == 0) return true;
    }
    return false;
}

/* TCC 没有 strtoll（且它的 long 是 32 位），手写解析 */
static CsayInt csay_str_to_int(CsayStr s) {
    CsayInt v = 0;
    int neg = 0;
    int64_t i = 0;
    while (i < s.n && (s.p[i] == ' ' || s.p[i] == '\t')) i++;
    if (i < s.n && (s.p[i] == '-' || s.p[i] == '+')) {
        neg = s.p[i] == '-';
        i++;
    }
    for (; i < s.n && s.p[i] >= '0' && s.p[i] <= '9'; i++) {
        v = v * 10 + (s.p[i] - '0');
    }
    return neg ? -v : v;
}

static CsayFloat csay_str_to_float(CsayStr s) {
    char* p = (char*)malloc((size_t)s.n + 1);
    memcpy(p, s.p, (size_t)s.n);
    p[s.n] = 0;
    CsayFloat v = (CsayFloat)atof(p);
    free(p);
    return v;
}

static CsayFloat32 csay_str_to_float32(CsayStr s) {
    return (CsayFloat32)csay_str_to_float(s);
}

static CsayBool csay_write_file(CsayStr path, CsayStr content) {
    char* name = (char*)malloc((size_t)path.n + 1);
    memcpy(name, path.p, (size_t)path.n);
    name[path.n] = 0;
    FILE* f = csay_fopen_utf8(name, "wb");
    free(name);
    if (f == NULL) return false;
    if (content.n > 0) fwrite(content.p, 1, (size_t)content.n, f);
    fclose(f);
    return true;
}

/* 流式文件句柄：最多同时打开 32 个，-1 表示失败 */
static FILE* csay_open_files[32];

static CsayInt csay_file_open(CsayStr path, CsayStr mode) {
    char* name = csay_cstr(path);
    char* how = csay_cstr(mode);
    const char* fmode = NULL;
    if (strcmp(how, "\xE8\xAF\xBB") == 0) fmode = "rb";
    else if (strcmp(how, "\xE5\x86\x99") == 0) fmode = "wb";
    else if (strcmp(how, "\xE8\xBF\xBD\xE5\x8A\xA0") == 0) fmode = "ab";
    if (fmode == NULL) {
        free(name); free(how);
        return -1;
    }
    FILE* f = csay_fopen_utf8(name, fmode);
    free(name); free(how);
    if (f == NULL) return -1;
    for (int i = 0; i < 32; i++) {
        if (csay_open_files[i] == NULL) {
            csay_open_files[i] = f;
            return (CsayInt)i;
        }
    }
    fclose(f);
    return -1;
}

static FILE* csay_file_at(CsayInt handle) {
    if (handle < 0 || handle >= 32) return NULL;
    return csay_open_files[handle];
}

static CsayStr csay_file_read_line(CsayInt handle) {
    FILE* f = csay_file_at(handle);
    if (f == NULL) return csay_lit("");
    int64_t cap = 256, n = 0;
    char* p = (char*)csay_alloc(cap);
    int c = 0;
    while ((c = fgetc(f)) != EOF) {
        if (c == '\n') break;
        if (c == '\r') continue;
        if (n + 1 >= cap) {
            int64_t ncap = cap * 2;
            char* q = (char*)csay_alloc(ncap);
            if (n > 0) memcpy(q, p, (size_t)n);
            p = q;
            cap = ncap;
        }
        p[n++] = (char)c;
    }
    if (c == EOF && n == 0) return csay_lit("");
    if (c == EOF) clearerr(f); /* 最后一行没有换行时，下一次读取才算到末尾 */
    p[n] = 0;
    return csay_str(p, n);
}

static CsayBool csay_file_write_line(CsayInt handle, CsayStr text) {
    FILE* f = csay_file_at(handle);
    if (f == NULL) return false;
    if (text.n > 0 && fwrite(text.p, 1, (size_t)text.n, f) != (size_t)text.n) return false;
    if (fputc('\n', f) == EOF) return false;
    return true;
}

static CsayBool csay_file_eof(CsayInt handle) {
    FILE* f = csay_file_at(handle);
    if (f == NULL) return true;
    return feof(f) != 0;
}

static void csay_file_close(CsayInt handle) {
    if (handle < 0 || handle >= 32) return;
    if (csay_open_files[handle] != NULL) {
        fclose(csay_open_files[handle]);
        csay_open_files[handle] = NULL;
    }
}

static CsayInt csay_round(CsayFloat v) {
    return (CsayInt)(v >= 0 ? v + 0.5 : v - 0.5);
}

