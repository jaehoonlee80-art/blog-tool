# 네이버 API 연결 가이드 — 블로그랩

이 문서는 블로그랩의 **샘플 데이터 자리에 실제 값을 채우는** 방법을 다룹니다.
바로 복사해서 쓰는 Next.js(App Router) 라우트 핸들러 3개와, 실패하기 쉬운 지점(서명·쿼터·캐시)을 정리했습니다.

---

## 0. 어떤 API가 무엇을 채우나

| 화면 | 필요한 값 | API | 공식 여부 |
|---|---|---|---|
| 키워드 분석 | 월 검색량(PC/모바일), 경쟁 정도, 연관 키워드 | **검색광고 API** `/keywordstool` | 공식 |
| 노출 진단 · 순위 추적 | 내 글의 검색 노출 여부·대략 순위 | **블로그 검색 OpenAPI** `/v1/search/blog.json` | 공식 |
| 블로그탭 순위, 문서수 | 블로그탭 실제 순위·총 문서수 | 공식 API 없음 → 크롬 확장 수집 | 비공식 |
| 오늘 방문자·수익 | 블로그 통계 | 공식 API 없음 → 확장/화면 읽기 | 비공식 |

> ⚠️ **블로그 검색 OpenAPI ≠ 블로그탭 순위**
> OpenAPI는 통합검색의 블로그 영역 결과를 돌려줍니다. 네이버 블로그의 "블로그탭" 순위와는 다를 수 있어요.
> 그래서 블로그랩은 OpenAPI 값을 **노출 여부 판정**에 쓰고, 정확한 블로그탭 순위는 확장이 기록하도록 나눴습니다.

---

## 1. 준비물과 발급 절차

### 1-1. 검색광고 API (검색량)

1. <https://searchad.naver.com> 접속 → 네이버 광고 계정으로 로그인
   (광고를 집행하지 않아도 계정만 있으면 API를 쓸 수 있습니다)
2. **도구 > API 관리** → 사용 목적 입력 후 신청
3. 발급되는 3가지 값을 메모

| 이름 | 환경변수 | 설명 |
|---|---|---|
| 액세스 라이선스 | `NAVER_AD_API_KEY` | 공개되어도 되는 키 |
| 비밀키 | `NAVER_AD_SECRET_KEY` | **절대 노출 금지.** 서명 생성에만 사용 |
| 고객 ID | `NAVER_AD_CUSTOMER_ID` | 숫자 ID |

### 1-2. 네이버 OpenAPI (블로그 검색)

1. <https://developers.naver.com/apps> → 애플리케이션 등록
2. 사용 API에서 **검색** 선택, 환경은 `WEB` 설정
3. `Client ID`, `Client Secret` 발급 (검색은 하루 25,000회)

### 1-3. 환경변수

```bash
# .env.local  (Vercel > Project > Settings > Environment Variables 에도 동일하게)
NAVER_AD_API_KEY=0100000000abcdef...
NAVER_AD_SECRET_KEY=...
NAVER_AD_CUSTOMER_ID=1234567
NAVER_OPENAPI_CLIENT_ID=...
NAVER_OPENAPI_CLIENT_SECRET=...
```

> 🔐 이 값들은 **서버 컴포넌트/라우트 핸들러에서만** 읽습니다. `NEXT_PUBLIC_` 접두사를 붙이면 브라우저 번들에 그대로 들어갑니다.

---

## 2. 검색광고 API — HMAC-SHA256 서명

검색광고 API는 매 요청마다 서명을 만들어야 합니다.

```
message   = timestamp + "." + method + "." + uri
signature = base64( HMAC_SHA256(secretKey, message) )
```

- `timestamp`: 밀리초 (예: `1700000000000`)
- `method`: `GET` 또는 `POST`
- `uri`: 경로만 (`/keywordstool`). 쿼리스트링은 넣지 않습니다.
- 요청 헤더 4개: `X-Timestamp`, `X-API-KEY`, `X-CUSTOMER`, `X-SIGNATURE`

### 2-1. `lib/naver-ad.ts`

```ts
import crypto from "node:crypto";

const BASE = "https://api.searchad.naver.com";

export type AdKeyword = {
  relKeyword: string;
  monthlyPcQcCnt: number | string;
  monthlyMobileQcCnt: number | string;
  compIdx: "낮음" | "중간" | "높음" | string;
  plAvgDepth?: number | string;
};

function signature(method: "GET" | "POST", uri: string) {
  const timestamp = String(Date.now());
  const secret = process.env.NAVER_AD_SECRET_KEY!;
  const message = `${timestamp}.${method}.${uri}`;
  const sig = crypto.createHmac("sha256", secret).update(message).digest("base64");

  return {
    "Content-Type": "application/json; charset=UTF-8",
    "X-Timestamp": timestamp,
    "X-API-KEY": process.env.NAVER_AD_API_KEY!,
    "X-CUSTOMER": process.env.NAVER_AD_CUSTOMER_ID!,
    "X-SIGNATURE": sig,
  };
}

/** "< 10" 같은 문자열을 숫자로. 0으로 취급하면 추천도가 왜곡되니 5로 둡니다. */
export function toCount(v: number | string | undefined): number {
  if (typeof v === "number") return v;
  if (!v) return 0;
  const digits = v.replace(/[^0-9]/g, "");
  if (!digits) return 0;
  const n = Number(digits);
  return /<\s*\d/.test(v) ? Math.max(n, 5) : n;
}

export async function fetchAdKeywords(seed: string): Promise<AdKeyword[]> {
  const uri = "/keywordstool";
  // hintKeywords 는 최대 5개까지 쉼표로 묶어 한 번에 조회할 수 있습니다.
  const qs = new URLSearchParams({
    hintKeywords: seed.replace(/\s+/g, "").slice(0, 40),
    showDetail: "1",
  });

  const res = await fetch(`${BASE}${uri}?${qs}`, {
    headers: signature("GET", uri),
    cache: "no-store",
  });

  if (res.status === 401 || res.status === 403) {
    // 서명 불일치 또는 키 오류
    throw new Error(`NAVER_AD_AUTH_${res.status}: ${await res.text()}`);
  }
  if (res.status === 429) throw new Error("NAVER_AD_RATE_LIMIT");
  if (!res.ok) throw new Error(`NAVER_AD_${res.status}: ${await res.text()}`);

  const data = (await res.json()) as { keywordList?: AdKeyword[] };
  return data.keywordList ?? [];
}
```

### 2-2. 추천도(경쟁도) 계산

공식 경쟁 정도는 `compIdx`(낮음/중간/높음)로 옵니다. 블로그랩의 0~100 점수는 아래처럼 **휴리스틱**으로 계산해 저장하세요. 문서수(`docCount`)가 있으면 그 값을 쓰고, 없으면 3-1 예시처럼 `compIdx`를 기본값으로 씁니다.

```ts
export function recommendScore(monthlyTotal: number, docCount: number) {
  if (monthlyTotal <= 0) return 0;
  if (!docCount) return monthlyTotal > 5000 ? 80 : 70;
  // 검색량이 많고 문서가 적을수록 높게. 로그 스케일로 0~99에 담습니다.
  const ratio = monthlyTotal / Math.max(docCount, 10);
  return Math.max(5, Math.min(99, Math.round(Math.log10(1 + ratio) * 55)));
}
```

> 이 점수는 앱 화면의 "추천도"와 같은 정의입니다. 실제 서비스에서는 `doc_count`를 확장이 수집한 블로그탭 문서수로 채우고, 없으면 OpenAPI `total`을 대신 씁니다.

---

## 3. Next.js 라우트 핸들러

### 3-1. 키워드 분석 API

```ts
// app/api/keywords/route.ts
import { NextRequest, NextResponse } from "next/server";
import { fetchAdKeywords, recommendScore, toCount } from "@/lib/naver-ad";

export const runtime = "nodejs";          // crypto 사용 → Edge 런타임 불가
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const seed = req.nextUrl.searchParams.get("q")?.trim();
  if (!seed) {
    return NextResponse.json({ error: "q(씨앗 키워드)가 필요합니다." }, { status: 400 });
  }

  try {
    const rows = await fetchAdKeywords(seed);

    const keywords = rows
      .map((r) => {
        const pc = toCount(r.monthlyPcQcCnt);
        const mobile = toCount(r.monthlyMobileQcCnt);
        const total = pc + mobile;
        // 문서수(블로그탭)는 확장/OpenAPI total로 채운다. 없을 때는 경쟁 정도(compIdx)로 대신한다.
        const base = r.compIdx === "낮음" ? 90 : r.compIdx === "중간" ? 74 : 58;
        return {
          keyword: r.relKeyword,
          monthlyPc: pc,
          monthlyMobile: mobile,
          monthlyTotal: total,
          competition:
            r.compIdx === "낮음" ? "low" : r.compIdx === "높음" ? "high" : "medium",
          score: Math.min(99, Math.round(base + Math.log10(1 + total / 1000) * 6)),
        };
      })
      .filter((k) => k.monthlyTotal > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, 50);

    // 캐시: 같은 씨앗을 24시간 재사용 (아래 5장 참고)
    return NextResponse.json(
      { seed, keywords, fetchedAt: new Date().toISOString() },
      { headers: { "Cache-Control": "private, max-age=86400" } }
    );
  } catch (e) {
    const msg = e instanceof Error ? e.message : "unknown";
    const status = msg.includes("RATE_LIMIT") ? 429 : 502;
    return NextResponse.json({ error: msg }, { status });
  }
}
```

### 3-2. 순위·노출 확인 API

```ts
// app/api/rank/route.ts
import { NextRequest, NextResponse } from "next/server";

const SEARCH = "https://openapi.naver.com/v1/search/blog.json";

type BlogItem = { title: string; link: string; bloggerlink?: string; postdate: string };

function normalize(url: string) {
  return url
    .replace(/^https?:\/\//, "")
    .replace(/^m\./, "")
    .replace(/[?#].*$/, "")
    .replace(/\/$/, "");
}

/** blog.naver.com/{id}/{logNo} 형태에서 logNo만 뽑아 비교 */
function logNoOf(url: string) {
  const m = normalize(url).match(/blog\.naver\.com\/[^/]+\/(\d+)/);
  return m ? m[1] : null;
}

export async function GET(req: NextRequest) {
  const postUrl = req.nextUrl.searchParams.get("url");
  const keyword = req.nextUrl.searchParams.get("q");
  if (!postUrl || !keyword) {
    return NextResponse.json({ error: "url, q가 필요합니다." }, { status: 400 });
  }

  const targetLogNo = logNoOf(postUrl);
  if (!targetLogNo) {
    return NextResponse.json({ error: "blog.naver.com 글 주소가 아닙니다." }, { status: 400 });
  }

  const headers = {
    "X-Naver-Client-Id": process.env.NAVER_OPENAPI_CLIENT_ID!,
    "X-Naver-Client-Secret": process.env.NAVER_OPENAPI_CLIENT_SECRET!,
  };

  // OpenAPI는 start 최대 1000, display 최대 100 → 최대 1,000위까지 확인 가능
  for (let start = 1; start <= 1000; start += 100) {
    const url = `${SEARCH}?query=${encodeURIComponent(keyword)}&display=100&start=${start}&sort=sim`;
    const res = await fetch(url, { headers, cache: "no-store" });

    if (res.status === 429) {
      return NextResponse.json({ error: "OpenAPI 호출 한도 초과" }, { status: 429 });
    }
    if (!res.ok) {
      return NextResponse.json({ error: `NAVER_OPENAPI_${res.status}` }, { status: 502 });
    }

    const data = (await res.json()) as { total: number; items: BlogItem[] };
    const index = data.items.findIndex(
      (it) => logNoOf(it.link) === targetLogNo || logNoOf(it.bloggerlink ?? "") === targetLogNo
    );

    if (index >= 0) {
      return NextResponse.json({
        keyword,
        rank: start + index,           // 통합검색 블로그 영역 기준
        exposed: true,
        total: data.total,
        checkedAt: new Date().toISOString(),
      });
    }

    if (data.items.length < 100) break; // 마지막 페이지
  }

  return NextResponse.json({
    keyword,
    rank: null,
    exposed: false,
    checkedAt: new Date().toISOString(),
  });
}
```

### 3-3. 결과 저장 (Supabase)

```ts
// app/api/rank/route.ts 안, 결과를 받은 뒤
import { createClient } from "@supabase/supabase-js";

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!   // 서버 전용
);

await supabase.from("rank_snapshots").upsert(
  {
    user_id: user.id,
    post_url: postUrl,
    keyword,
    rank,
    is_exposed: exposed,
    checked_on: new Date().toISOString().slice(0, 10),
  },
  { onConflict: "user_id,post_url,keyword,checked_on" }
);
```

> 사용자 요청마다 저장하지 말고, **하루 1회 크론**(Vercel Cron → `/api/cron/ranks`)에서 추적 목록 전체를 돌리는 편이 쿼터·속도 모두 유리합니다.

---

## 4. 레이트리밋·쿼터를 지키는 방법

| 항목 | 한도 | 대응 |
|---|---|---|
| 검색광고 API | 초당 요청 수 제한(계정별) | 씨앗 5개씩 묶어 호출, 실패 시 1s → 2s → 4s 백오프 |
| 블로그 검색 OpenAPI | 25,000회/일 | 사용자당 하루 3~5회로 제한, 결과 24h 캐시 |
| 순위 확인 | 1회당 최대 10요청(1,000위) | 100위 안에서 못 찾으면 중단하고 `null` 저장 |

```ts
// 지수 백오프 + 재시도
export async function withRetry<T>(fn: () => Promise<T>, tries = 3): Promise<T> {
  let last: unknown;
  for (let i = 0; i < tries; i++) {
    try {
      return await fn();
    } catch (e) {
      last = e;
      const msg = e instanceof Error ? e.message : "";
      if (!msg.includes("429") && !msg.includes("RATE_LIMIT")) throw e;
      await new Promise((r) => setTimeout(r, 1000 * 2 ** i));
    }
  }
  throw last;
}
```

### 캐시 두 겹

1. **HTTP**: `Cache-Control: private, max-age=86400` (같은 사용자의 반복 조회 흡수)
2. **DB**: `keywords_history`에 `collected_on`(KST 날짜)을 두고 upsert → 하루 한 번만 실제 호출

```ts
const today = new Date().toLocaleDateString("sv-SE", { timeZone: "Asia/Seoul" }); // YYYY-MM-DD

const { data: cached } = await supabase
  .from("keywords_history")
  .select("*")
  .eq("user_id", user.id)
  .eq("keyword", keyword)
  .eq("collected_on", today)
  .maybeSingle();

if (cached) return cached; // API 호출 생략
```

---

## 5. 자주 나는 오류

| 증상 | 원인 | 해결 |
|---|---|---|
| `401` + `Signature` 관련 | 서명 문자열에 쿼리스트링 포함/누락, 시계 오차 | `uri`는 경로만, 서버 시각을 NTP로 동기화 |
| `403` | 고객 ID 불일치 또는 API 미신청 | `X-CUSTOMER` 값과 API 관리 화면 재확인 |
| `429` | 호출 한도 | 백오프 + 캐시 (4장) |
| 검색량이 모두 0 | `< 10` 문자열을 `Number()`로 변환 | `toCount()`처럼 숫자만 추출 |
| 순위가 항상 null | `postUrl`이 `m.blog.naver.com` 형태 | `logNoOf()`로 정규화 후 비교 |
| Vercel 빌드 실패 | `crypto` 사용 | `export const runtime = "nodejs"` 지정 |

---

## 6. 약관·보안 체크리스트

- 키는 서버에만. GitHub에 올라가면 즉시 재발급하세요.
- 네이버 이용약관은 자동화된 대량 수집을 제한합니다. 사용자 1명당 호출량을 제한하고, 공식 API로 대체 가능한 값은 공식 API를 쓰세요.
- 블로그 화면에서 읽는 값(방문자·블로그탭 순위)은 **사용자가 직접 로그인한 브라우저 안에서만** 처리하고, 서버로 원문을 보내지 않는 구성이 안전합니다.
- 개인정보처리방침에 수집 항목(블로그 주소, 키워드, 순위 기록)과 보관 기간(예: 90일/2년)을 명시하세요. `supabase-schema.sql`의 `prune_old_history()`가 그 기준으로 정리합니다.
