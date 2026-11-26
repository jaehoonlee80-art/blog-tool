# 블로그랩 (Blog Lab) — 네이버 블로그 SEO 툴

네이버 블로그를 쓰는 사람을 위한 **키워드 → 글쓰기 점검 → 이미지 워싱 → 순위 확인** 도구입니다.
바로 쓰는 웹앱(1개 파일)과, 서비스로 키울 때 쓰는 런칭 키트(스키마·확장·API 가이드)로 나뉩니다.

```
blog-tool/
├── index.html                  ← 웹앱 (외부 CDN 0개, 파일 하나로 동작)
├── README.md
└── saas-kit/
    ├── supabase-schema.sql     ← 6개 테이블 + RLS + 트리거 + 사용량 뷰
    ├── naver-api-guide.md      ← 검색광고 HMAC 인증 · 블로그 검색 OpenAPI · Next.js 예제
    └── chrome-extension/       ← Manifest V3 확장 (압축해제 후 로드)
        ├── manifest.json
        ├── content.js          ← blog.naver.com 글쓰기 화면 도우미 바
        ├── popup.html
        ├── popup.js
        └── icons/
```

---

## 1. 웹앱 실행

### 가장 간단하게
`index.html`을 브라우저로 열면 끝입니다. 서버·빌드·설치가 없습니다.

### 로컬 서버로 (권장)
```bash
cd blog-tool
python3 -m http.server 8080
# http://localhost:8080
```

### GitHub Pages (배포 중)
- 라이브: <https://jaehoonlee80-art.github.io/blog-tool/>
- 저장소: <https://github.com/jaehoonlee80-art/blog-tool> (이 폴더가 저장소 루트)
- 배포 소스: **`gh-pages` 브랜치 / 루트(`/`)** · Settings > Pages > Source: `Deploy from a branch`

`main`과 `gh-pages`는 같은 내용으로 맞춰 두었습니다. 고친 뒤에는 두 브랜치를 함께 올립니다.
```bash
git push origin main
git push origin main:gh-pages   # 이 줄이 있어야 사이트가 갱신됩니다
```

> 로컬 파일(`file://`)에서도 모든 기능이 동작하도록 외부 CDN·폰트·이미지를 쓰지 않았습니다.
> 다만 크롬 확장은 `chrome://extensions`에서 폴더를 직접 로드해야 하고, `file://` 페이지에서는 확장이 주입되지 않습니다.

---

## 2. 화면과 기능

| 탭 | 실제로 동작하는 것 | 샘플 데이터인 것 |
|---|---|---|
| **대시보드** | 발행 리듬·체크리스트 계산 | 오늘 방문자, 검색 노출률, 최근 글 |
| **글쓰기 점검** | 제목 30자 배지, 공백 포함/제외 글자수, 문단 수, 읽기 시간, 자주 쓴 단어·구절 TOP 10, 반복 경고, 빠른 서식 저장/삭제/커서 삽입, 워드(.doc) 저장, 자동 저장 | — |
| **이미지 워싱** | 업로드 → 캔버스 재드로잉(EXIF 제거) → 크롭·색감·노이즈·미세 회전 → JPG 다운로드, 테스트 이미지 생성 | — |
| **키워드 분석** | 검색·필터·정렬, 담기/복사(localStorage) | 검색량·문서수·경쟁도·추천도 |
| **순위 추적** | 글·키워드 등록/삭제, SVG 추이 차트, 일별 표, 노출 진단(현재 원고 기준) | 실제 순위 기록 |
| **크롬 확장 · 요금제** | 설치 안내, 경로 복사, 월/연 요금 토글 | 결제 연동 |

### 데이터가 저장되는 곳
| 키 | 내용 |
|---|---|
| `blab_draft_v1` / `blab_title_v1` | 작성 중인 글 (자동 저장) |
| `blab_tpl_v1` | 내가 만든 빠른 서식 |
| `blab_saved_kw_v1` | 담은 키워드 |
| `blab_tracks_v1` | 추적 중인 글 목록 |

모두 브라우저 `localStorage`에만 저장되고 서버로 전송되지 않습니다. (브라우저 데이터를 지우면 함께 사라집니다.)

### 이미지 워싱 강도
| 강도 | 크롭 | 색감(밝기/대비/채도) | 노이즈 |
|---|---|---|---|
| 약하게 | 1px | ±1% | ±1 |
| 보통 | 2px | ±2~3% | ±1.8 |
| 강하게 | 3px | ±3~5% | ±2.8 |

캔버스에 다시 그려 저장하므로 **원본 EXIF·GPS·촬영일시·기기 정보는 결과 파일에 남지 않습니다.**
원본 파일은 수정하지 않습니다(다운로드는 새 파일).

---

## 3. SaaS로 키울 때

### 3-1. Supabase
1. 프로젝트 생성 → SQL Editor에서 `saas-kit/supabase-schema.sql` 실행
2. Authentication에서 로그인 수단(Email, Kakao) 활성화
3. 가입 시 `profiles` 행이 트리거로 자동 생성되는지 확인

포함된 테이블: `profiles`, `keywords_history`, `rank_snapshots`, `exposure_checks`, `quick_templates`, `subscriptions`
— 전부 RLS가 켜져 있고 `auth.uid() = user_id` 조건만 허용합니다.
`subscriptions`는 조회만 허용하고, 쓰기는 결제 웹훅이 `service_role`로 수행합니다.

### 3-2. 네이버 API
`saas-kit/naver-api-guide.md`의 순서대로:
1. 검색광고 API 키 발급 → `NAVER_AD_*` 환경변수
2. OpenAPI 애플리케이션 등록 → `NAVER_OPENAPI_*`
3. `lib/naver-ad.ts`, `app/api/keywords/route.ts`, `app/api/rank/route.ts` 붙여넣기
4. 하루 1회 크론으로 순위 수집 → `rank_snapshots` upsert

### 3-3. 크롬 확장
1. `chrome://extensions` → 개발자 모드 ON
2. **압축해제된 확장 프로그램을 로드** → `blog-tool/saas-kit/chrome-extension` 선택
3. `https://blog.naver.com/PostWriteForm.naver` 접속 → 왼쪽 아래 **블로그랩** 바 확인
4. 툴바 아이콘 → 빠른 서식 추가/삭제, 도우미 바 on/off

> 네이버 스마트에디터가 iframe 안에 있어 `all_frames: true`로 모든 프레임에서 값을 읽습니다.
> 같은 출처면 DOM을 직접 순회하고, 격리된 프레임은 `postMessage`로 보완합니다.

### 3-4. 결제
`subscriptions` 테이블이 Stripe/토스페이먼츠 상태의 원본입니다.
웹훅에서 `status`, `current_period_end`를 갱신하고 `profiles.plan`을 동기화하세요.
요금제 화면의 가격은 `index.html`의 `PLANS` 배열에서 수정합니다.

---

## 4. 알아둘 점

- **블로그탭 순위와 문서수는 공식 API가 없습니다.** 통합검색 OpenAPI 결과와 다를 수 있어, 앱은 OpenAPI를 "노출 여부"에 쓰고 정확한 순위는 확장 기록으로 채우는 구조입니다.
- 검색량은 검색광고 API 쿼터가 있어 캐시(24시간) 없이 호출하면 금방 한도에 걸립니다.
- 이미지 워싱은 촬영 정보를 지우는 용도입니다. 타인의 사진을 재사용하는 것은 별개의 저작권 문제입니다.
- 요금제·방문자 수치는 런칭 전 시안 값입니다.

---

## 5. 검증

헤드리스 Chromium(1440×900, 390×844)에서 아래를 확인했습니다. (콘솔 오류 0, 페이지 오류 0)

- 탭 전환, 모바일 하단 내비게이션, 가로 스크롤 없음
- 제목 3구간(짧음/정상/30자 초과) 배지, 글자수·문단·읽기 시간 실시간 일치
- 반복 단어 TOP 10 계산, 서식 저장 → 새로고침 후 유지, 커서 위치 삽입, 삭제
- `.doc` 다운로드: UTF-8 BOM + 제목/문단 포함
- 테스트 이미지 생성 → 워싱 결과 디코딩(1398×932), 메타데이터 제거 표시, JPG 다운로드
- 키워드 필터/정렬/담기, 순위 차트·표·진단 점수, 요금 토글
- 확장: 모의 네이버 글쓰기(iframe)에서 제목 28/30·글자수·단어 표시, 서식 삽입, 30자 초과 경고
