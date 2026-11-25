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
typedef double CsayFloat;
typedef bool CsayBool;

typedef struct { const char* p; int64_t n; } CsayStr;

typedef struct { CsayStr msg; CsayInt kind; } CsayError;

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

static void* csay_alloc(int64_t n) {
    n = (n + 7) & ~7LL;
    if (n <= 0) n = 8;
    if (csay_region_top == NULL) return malloc((size_t)n);
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

static CsayInt csay_timestamp(void) {
    return (CsayInt)time(NULL);
}

static CsayStr csay_format_time(CsayInt seconds, CsayStr format) {
    time_t t = (time_t)seconds;
    struct tm* tm = localtime(&t);
    if (tm == NULL) return csay_lit("");
    char fmt[128];
    int64_t n = format.n < 127 ? format.n : 127;
    if (n > 0) memcpy(fmt, format.p, (size_t)n);
    fmt[n] = 0;
    char buf[512];
    size_t got = strftime(buf, sizeof buf, fmt, tm);
    return csay_str_copy_c(got > 0 ? buf : "");
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
            out = (char*)realloc(out, (size_t)cap);
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
    CsayList* l = (CsayList*)malloc(sizeof(CsayList));
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

static CsayFloat csay_list_pop_back_float(CsayList* l) {
    if (l->len == 0) { csay_throw_error(csay_error(csay_lit("栈为空"), CSAY_ERR_INDEX)); return 0.0; }
    CsayFloat v = *(CsayFloat*)(l->data + (l->len - 1) * l->elem);
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

/* 轻量正则：字面量、.、*、+、?、^、$ 和反斜杠转义，不支持分组和字符类。 */
static int csay_re_seq(const char* p, int n, int pos) {
    if (pos < 0 || pos >= n) return 0;
    int len = csay_utf8_seq_len((unsigned char)p[pos]);
    if (len < 1) len = 1;
    if (pos + len > n) len = n - pos;
    return len;
}

static int csay_re_atom(const char* p, int pn, int pi, int* alen,
                        const char** lit, int* litlen, int* dot) {
    if (pi >= pn) return 0;
    if (p[pi] == '\\' && pi + 1 < pn) {
        int l = csay_re_seq(p, pn, pi + 1);
        *lit = p + pi + 1;
        *litlen = l;
        *alen = 1 + l;
        *dot = 0;
        return 1;
    }
    if (p[pi] == '.') {
        *lit = NULL;
        *litlen = 0;
        *alen = 1;
        *dot = 1;
        return 1;
    }
    int l = csay_re_seq(p, pn, pi);
    *lit = p + pi;
    *litlen = l;
    *alen = l;
    *dot = 0;
    return 1;
}

static int csay_re_atom_next(const char* t, int tn, int ti,
                             const char* lit, int litlen, int dot) {
    if (dot) {
        int l = csay_re_seq(t, tn, ti);
        return l > 0 ? ti + l : -1;
    }
    if (ti + litlen > tn) return -1;
    if (memcmp(t + ti, lit, (size_t)litlen) != 0) return -1;
    return ti + litlen;
}

static int csay_re_match(const char* p, int pn, int pi, const char* t, int tn, int ti) {
    if (pi >= pn) return ti;
    if (p[pi] == '$' && pi + 1 == pn) return ti == tn ? ti : -1;
    if (p[pi] == '^' && pi == 0) return ti == 0 ? csay_re_match(p, pn, pi + 1, t, tn, ti) : -1;
    if (p[pi] == '*' || p[pi] == '+' || p[pi] == '?') return -1;

    int alen = 0, litlen = 0, dot = 0;
    const char* lit = NULL;
    if (!csay_re_atom(p, pn, pi, &alen, &lit, &litlen, &dot)) return -1;
    int next = pi + alen;
    char q = next < pn ? p[next] : 0;
    if (q != '*' && q != '+' && q != '?') {
        int np = csay_re_atom_next(t, tn, ti, lit, litlen, dot);
        return np < 0 ? -1 : csay_re_match(p, pn, next, t, tn, np);
    }

    int min = q == '+' ? 1 : 0;
    int max = q == '?' ? 1 : 1000000000;
    int pos = ti;
    int count = 0;
    while (count < max) {
        int np = csay_re_atom_next(t, tn, pos, lit, litlen, dot);
        if (np < 0) break;
        pos = np;
        count++;
    }
    for (int k = count; k >= min; k--) {
        int p2 = ti;
        for (int j = 0; j < k; j++) p2 = csay_re_atom_next(t, tn, p2, lit, litlen, dot);
        int r = csay_re_match(p, pn, next + 1, t, tn, p2);
        if (r >= 0) return r;
    }
    return -1;
}

static CsayInt csay_regex_search(CsayStr text, CsayStr pat, CsayInt* endOut) {
    int start = 0;
    while (start <= text.n) {
        int r = csay_re_match(pat.p, (int)pat.n, 0, text.p, (int)text.n, start);
        if (r >= 0) {
            *endOut = r;
            return start;
        }
        if (start == text.n) break;
        int l = csay_re_seq(text.p, (int)text.n, start);
        start += l > 0 ? l : 1;
    }
    return -1;
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
    CsayInt m = *(CsayInt*)l->data;
    for (int64_t i = 1; i < l->len; i++) {
        CsayInt v = *(CsayInt*)(l->data + i * l->elem);
        if (v > m) m = v;
    }
    return m;
}

static CsayFloat csay_list_max_float(CsayList* l) {
    CsayFloat m = *(CsayFloat*)l->data;
    for (int64_t i = 1; i < l->len; i++) {
        CsayFloat v = *(CsayFloat*)(l->data + i * l->elem);
        if (v > m) m = v;
    }
    return m;
}

static CsayStr csay_list_max_str(CsayList* l) {
    CsayStr m = *(CsayStr*)l->data;
    for (int64_t i = 1; i < l->len; i++) {
        CsayStr v = *(CsayStr*)(l->data + i * l->elem);
        if (csay_cmp_str(&v, &m) > 0) m = v;
    }
    return m;
}

/**
 * 把文本复制到当前区域之外。
 * 用法：区域 { 文本 t = ...; 返回 保留(t); }
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
            char* p = (char*)malloc((size_t)bytes + 1);
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

static CsayMap* csay_map_new(int64_t keySize, int64_t valSize,
                             uint64_t (*hash)(const void*),
                             int (*eq)(const void*, const void*)) {
    CsayMap* m = (CsayMap*)malloc(sizeof(CsayMap));
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

/* 条目遍历：每个 键×值 组合一份结构和一个遍历函数 */

typedef struct { CsayStr key; CsayInt val; } CsayEntry_文本_整数;
typedef struct { CsayStr key; CsayFloat val; } CsayEntry_文本_小数;
typedef struct { CsayStr key; CsayStr val; } CsayEntry_文本_文本;
typedef struct { CsayStr key; CsayBool val; } CsayEntry_文本_真假;
typedef struct { CsayInt key; CsayInt val; } CsayEntry_整数_整数;
typedef struct { CsayInt key; CsayFloat val; } CsayEntry_整数_小数;
typedef struct { CsayInt key; CsayStr val; } CsayEntry_整数_文本;
typedef struct { CsayInt key; CsayBool val; } CsayEntry_整数_真假;

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

static CsayList* csay_map_entries_文本_小数(CsayMap* m) {
    CsayList* l = csay_list_new((int64_t)sizeof(CsayEntry_文本_小数));
    for (int64_t i = 0; i < m->cap; i++) {
        if (!m->used[i]) continue;
        CsayEntry_文本_小数 e;
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

static CsayList* csay_map_entries_整数_小数(CsayMap* m) {
    CsayList* l = csay_list_new((int64_t)sizeof(CsayEntry_整数_小数));
    for (int64_t i = 0; i < m->cap; i++) {
        if (!m->used[i]) continue;
        CsayEntry_整数_小数 e;
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

/* ---------------- 文本切分 ---------------- */

static CsayList* csay_split(CsayStr s, CsayStr sep) {
    CsayList* l = csay_list_new((int64_t)sizeof(CsayStr));
    if (sep.n == 0) {
        csay_list_add(l, &s);
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
    return e;
}

static CsayStr csay_error_kind_name(CsayInt kind) {
    if (kind == CSAY_ERR_ARG) return csay_lit("\xE5\x8F\x82\xE6\x95\xB0\xE5\xBC\x82\xE5\xB8\xB8");
    if (kind == CSAY_ERR_STATE) return csay_lit("\xE7\x8A\xB6\xE6\x80\x81\xE5\xBC\x82\xE5\xB8\xB8");
    if (kind == CSAY_ERR_FILE) return csay_lit("\xE6\x96\x87\xE4\xBB\xB6\xE5\xBC\x82\xE5\xB8\xB8");
    if (kind == CSAY_ERR_INDEX) return csay_lit("\xE8\xB6\x8A\xE7\x95\x8C\xE5\xBC\x82\xE5\xB8\xB8");
    if (kind == CSAY_ERR_FORMAT) return csay_lit("\xE6\xA0\xBC\xE5\xBC\x8F\xE5\xBC\x82\xE5\xB8\xB8");
    return csay_lit("\xE5\xBC\x82\xE5\xB8\xB8");
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
            char* p = (char*)malloc((size_t)bytes + 1);
            if (bytes > 0) WideCharToMultiByte(65001, 0, wbuf, (int)got, p, bytes, NULL, NULL);
            p[bytes] = 0;
            return csay_str(p, bytes);
        }
    }
#endif
    int64_t cap = 128;
    int64_t len = 0;
    char* buf = (char*)malloc((size_t)cap);
    int c;
    while ((c = fgetc(stdin)) != EOF && c != '\n') {
        if (len + 1 >= cap) {
            cap *= 2;
            buf = (char*)realloc(buf, (size_t)cap);
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

