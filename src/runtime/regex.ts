export const RUNTIME_REGEX_C = String.raw`
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
`;
