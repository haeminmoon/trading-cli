# trend — 멀티 타임프레임 추세 판단 도구

6개 거래소 CLI가 가져온 **캔들(kline)** 을 받아서, 여러 타임프레임에 걸쳐 **이동평균선(EMA) + MACD** 기반으로 추세/진입 신호(+1/−1/0)를 판단하고, 원하면 **차트 PNG**(캔들 + EMA20/50/100 + MACD 히스토그램)까지 그려주는 분석 도구입니다.

> 설계 원칙: **CLI는 데이터만, 분석은 여기서.** 각 거래소 CLI(`@2oolkit/*`)는 캔들을 JSON으로 내보내는 어댑터 역할만 하고, 지표·신호 로직은 거래소 무관한 순수 모듈로 분리돼 있습니다.

## 사용법

```bash
npm run trend -- <거래소> <심볼|종목명> [옵션]

# 예시
npm run trend -- hyperliquid BTC --image        # 1h/4h/8h/1d + 차트 4장
npm run trend -- kiwoom 삼성전자                  # 이름 자동→005930, 1h/1d/1w
npm run trend -- backpack btc --json             # JSON 출력 (자동화/파이프)
npm run trend -- grvt btc --tf 4h,1d --image     # 타임프레임 지정
```

옵션: `--tf <목록>`(기본=거래소별 세트) · `--count <n>`(기본 300, 최소 120) · `--image`(PNG 생성) · `--out <dir>`(기본 `trend/out`) · `--json`.

### 일괄 스캔 (`trend:scan`)

한 거래소의 **상장 전 종목**을 스캔해 추세 신호로 필터링/정렬합니다 (`listSymbols` 지원: grvt = 전 종목, kiwoom = 거래대금 상위 ETF 제외; 그 외는 `--symbols`).

```bash
npm run trend:scan -- grvt                       # 상승추세(LONG) 종목, 4h 기준
npm run trend:scan -- grvt --tf 1d --filter short  # 일봉 하락추세
npm run trend:scan -- grvt --filter all --json   # 전체, JSON

# 명시 종목 리스트(워치리스트/섹터) 스캔 — 어떤 거래소든 가능 (listSymbols 불필요)
npm run trend:scan -- toss --symbols 329180,042660,010140 --tf 1d --concurrency 1 --image
```

```bash
# 멀티 타임프레임 AND — 여러 TF 모두 신호 충족해야 매칭 (강력한 추세 정렬 필터)
npm run trend:scan -- kiwoom --tf 1d,1w --filter long   # 일봉 AND 주봉 둘 다 상승추세
```

옵션: `--symbols a,b,c`(명시 종목 리스트; 종목명/코드 자동 해석) · `--tf 4h` (콤마로 여러 개 → **모든 TF에서 신호 충족해야 매칭**, 예 `1d,1w`) · `--count 250`(최소 120) · `--filter long|short|all`(기본 long) · `--concurrency 8`(토스/키움 등 rate-limit 거래소는 낮게) · `--limit N`(앞 N개만) · `--image`(종목별 차트 PNG, `--out` 폴더) · `--json`. 단일 TF면 EMA20/50/100·배열·MACD 상세, 멀티 TF면 TF별 신호 컬럼을 표시. 데이터(120봉) 부족 종목은 자동 제외 — **주봉(1w)은 EMA100에 ~120주가 필요해 신생 거래소(크립토)·신규 상장주는 제외됨**(키움 대형주는 가능).

## 주도주 스캐너 (`trend:leaders`)

대장주/주도주를 **종합 점수**로 랭킹합니다 (미너비니·오닐式). 0~100 균형 점수 = **상대강도(RS) %ile + 추세품질(정배열·EMA기울기·MACD) + 신고가 근접 + 유동성 %ile + 수급(외인·기관, 국내주 한정)** 의 평균.

```bash
npm run trend:leaders -- kiwoom                 # 국내주식: 거래대금 상위(ETF 제외)를 RS+추세+수급으로 랭킹
npm run trend:leaders -- kiwoom --show 20 --image  # 상위 20 + 차트 PNG
npm run trend:leaders -- grvt --show 15         # 암호화폐(grvt 전 종목)
npm run trend:leaders -- kiwoom --include-etf    # ETF 포함
```

- **유니버스**: kiwoom → 거래대금 상위(`--top`, 기본 60, ETF 자동 제외) · `listSymbols` 거래소(grvt) → 전 종목 · 그 외 `--symbols a,b,c`.
- 옵션: `--top N`(후보 수) · `--show N`(표시 상위, 기본 20) · `--count 252`(RS·신고가 계산용 일봉) · `--concurrency`(kiwoom 4 권장) · `--include-etf` · `--image` · `--json` · `--out`.
- 점수 컬럼: `RS%`(시장 대비 상대강도 백분위) · `추세`(정배열 등 4조건 충족률) · `고점%`(**가용 기간 내** 고점 대비 현재가 — 100=신고가, 73=고점보다 27%↓; 52주가 아닐 수 있음) · `유동성%`(거래대금 백분위) · `수급`(외인+기관/한쪽/-) · `봉수`(데이터 길이; **<150은 ⚠** = 신생 상장이라 추세·고점 신뢰도↓). 데이터가 짧으면(예: 신생 거래소) `고점%`는 단기 고점 기준임에 유의.

## 거래소별 타임프레임

| 거래소 | 종류 | 추세 타임프레임 | 심볼 입력 |
|---|---|---|---|
| hyperliquid | 암호화폐 | 1h · 4h · 8h · 1d | 코인명 (`btc`→`BTC`) |
| backpack | 암호화폐 | 1h · 4h · 8h · 1d | 코인명 자동 매칭 (`btc`→`BTC_USDC_PERP`) |
| grvt | 암호화폐 | 1h · 4h · 8h · 1d | 코인명 자동 매칭 (`btc`→`BTC_USDT_Perp`) |
| pacifica | 암호화폐 | 1h · 4h · 8h · 1d | 코인명 (`btc`→`BTC`) |
| kiwoom | 국내주식 | 1h(60분) · 1d · 1w | 코드 또는 종목명 (`삼성전자`→`005930`) |
| toss | 국내·미국주식 | 1d | 코드/티커 (`005930`, `AAPL`) |

## 지표 (`indicators.ts`)

| 지표 | 정의 | 용도 |
|---|---|---|
| EMA20 / EMA50 / EMA100 | 종가 EMA (SMA 시드 후 k=2/(n+1)) | 정배열/역배열 |
| MACD 히스토그램 | (EMA12−EMA26) − signalEMA9 | 모멘텀 방향 |
| ATR(14, Wilder) | True Range의 Wilder 평활 | 변동성(손절·트레일폭) |
| EMA100 기울기 | EMA100[현재] − EMA100[20봉 전] | 숏 레짐 필터 |

## 신호 (`signal.ts`)

| 신호 | 조건 (전부 충족) |
|---|---|
| **+1 LONG** | 정배열(EMA20>EMA50>EMA100) AND MACD히스토 > 0 |
| **−1 SHORT** | 역배열(EMA20<EMA50<EMA100) AND MACD히스토 < 0 AND EMA100 기울기 < 0 |
| **0 FLAT** | 그 외 |

종합 신호 = 타임프레임별 신호 합계 → `LONG 우위`/`SHORT 우위`/`혼조·관망`.

## 구조

```
trend/
  types.ts        # Candle / Indicators / Signal / Adapter 계약
  indicators.ts   # emaSeries, macdHistogramSeries, atrWilderSeries, computeIndicators
  signal.ts       # evaluateSignal (+1/−1/0)
  chart.ts        # renderChart → PNG (@napi-rs/canvas)
  adapters/       # 거래소별: resolveSymbol + fetchCandles (CLI를 -o json 으로 호출해 정규화)
  trend.ts        # 러너 (CLI 진입점)
  indicators.test.ts
```

테스트: `npm run test:trend` (vitest). 지표/신호는 순수 함수라 결정적으로 검증됩니다.

## 메모

- 캔들은 각 거래소 CLI를 통해 가져오므로, 해당 CLI가 설정돼 있어야 합니다(대부분 시세는 공개라 인증 불필요; grvt는 공개 캔들).
- `--count`는 EMA100+기울기 계산에 최소 120봉이 필요해 120 미만은 120으로 올립니다(기본 300).
- 신호는 **추세 판단 보조용**이며 투자 조언이 아닙니다. 주문은 각 CLI의 order 명령에서 별도로 이뤄집니다.
