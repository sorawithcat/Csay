export const RUNTIME_JSON_C = String.raw`
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
`
