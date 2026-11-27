export const RUNTIME_STDLIB_C = String.raw`
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
`
