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
