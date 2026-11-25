# Graph Report - Telegram_sheets_Bot  (2026-11-25)

## Corpus Check
- cluster-only mode — file stats not available

## Summary
- 119 nodes · 231 edges · 11 communities
- Extraction: 86% EXTRACTED · 14% INFERRED · 0% AMBIGUOUS · INFERRED: 32 edges (avg confidence: 0.85)
- Token cost: 40,941 input · 162 output

## Graph Freshness
- Built from commit: `206032ab`
- Run `git rev-parse HEAD` and compare to check if the graph is stale.
- Run `graphify update .` after code changes (no API cost).

## Community Hubs (Navigation)
- Telegram Bot Core
- Package Dependencies Config
- Weekly Message Builder
- Event Date Formatting
- Report Constants and Config
- Peredachi Query Formatting
- Localized Weekly Text Helpers
- Check Report Generation
- Tab Event Parsing
- Weekly Report Generation
- CSV Sheet Fetching

## God Nodes (most connected - your core abstractions)
1. `buildWeeklyMessage()` - 13 edges
2. `weeklyEventBlockEn()` - 9 edges
3. `weeklyEventBlockRu()` - 8 edges
4. `buildCheckMessage()` - 8 edges
5. `formatPeredachiReply()` - 7 edges
6. `generateCheckReport()` - 7 edges
7. `parseTabEvents()` - 7 edges
8. `fetchTabEvents()` - 6 edges
9. `warningBlockEn()` - 6 edges
10. `collectWeekEvents()` - 6 edges

## Surprising Connections (you probably didn't know these)
- `handleReportCommand()` --calls--> `chunkMessage()`  [EXTRACTED]
  index.js → report.js

## Import Cycles
- None detected.

## Communities (11 total, 0 thin omitted)

### Community 0 - "Telegram Bot Core"
Cohesion: 0.13
Nodes (12): bot, handleReportCommand(), { OpenAI, toFile }, TelegramBot, Anthropic, extractPeredachi(), addRecords(), fs (+4 more)

### Community 1 - "Package Dependencies Config"
Cohesion: 0.15
Nodes (15): dependencies, @anthropic-ai/sdk@^0.116.0, node-telegram-bot-api@^0.66.0, openai@^4.52.0, description, engines, node, main (+7 more)

### Community 2 - "Weekly Message Builder"
Cohesion: 0.21
Nodes (13): buildWeeklyMessage(), enMissingHeader(), formatMonthDayEn(), formatPoint24h(), ruBroadcastWord(), ruFewForm(), ruHostPhrase(), ruIsOneForm() (+5 more)

### Community 3 - "Event Date Formatting"
Cohesion: 0.21
Nodes (13): checkEventBlockEn(), checkEventBlockRu(), formatEventDateEn(), formatEventDateRu(), formatPoint12h(), formatRange12h(), formatRange24h(), formatWeeklyDateEn() (+5 more)

### Community 4 - "Report Constants and Config"
Cohesion: 0.17
Nodes (11): RFC-4180, ACADEMIC_KEYWORDS, CONFIG_PATH, fs, MONTHS, MONTHS_EN_FULL, MONTHS_RU_GENITIVE, path (+3 more)

### Community 5 - "Peredachi Query Formatting"
Cohesion: 0.36
Nodes (10): escapeMarkdown(), extractCourseNumbers(), formatCourseSection(), formatDateRu(), formatPeredachiReply(), formatRecordBlock(), getNowMsk(), isUpcoming() (+2 more)

### Community 6 - "Localized Weekly Text Helpers"
Cohesion: 0.22
Nodes (11): addDays(), ctaLineEn(), ctaLineRu(), formatMonthDayRu(), formatMonthDayShortEn(), formatWeeklyDateRu(), mskSuffixEn(), mskSuffixRu() (+3 more)

### Community 7 - "Check Report Generation"
Cohesion: 0.29
Nodes (8): buildCheckMessage(), enHostPhrase(), formatDebugCounts(), formatWeekRangeEn(), formatWeekRangeRu(), generateCheckReport(), getCurrentWeekRange(), loadCommunityTags()

### Community 8 - "Tab Event Parsing"
Cohesion: 0.40
Nodes (6): deriveMsk(), findHeaderSegments(), normalize(), parseDateFromText(), parseTabEvents(), parseTimeToMinutes()

### Community 9 - "Weekly Report Generation"
Cohesion: 0.40
Nodes (5): collectWeekEvents(), generateWeeklyReport(), getNextWeekRange(), inRange(), loadConfig()

### Community 10 - "CSV Sheet Fetching"
Cohesion: 0.50
Nodes (4): csvUrl(), fetchTabEvents(), fetchWithTimeout(), parseCsv()

## Knowledge Gaps
- **1 isolated node(s):** `RFC-4180`
  These have ≤1 connection - possible missing edges. (Counts symbols only; 26 node(s) total have ≤1 connection when file, concept and rationale nodes are included.)

## Suggested Questions
_Questions this graph is uniquely positioned to answer:_

- **Why does `node-telegram-bot-api` connect `Package Dependencies Config` to `Telegram Bot Core`?**
  _High betweenness centrality (0.089) - this node is a cross-community bridge._
- **Are the 3 inferred relationships involving `buildWeeklyMessage()` (e.g. with `report.js` and `weeklyEventBlockEn()`) actually correct?**
  _`buildWeeklyMessage()` has 3 INFERRED edges - model-reasoned connections that need verification._
- **What connects `RFC-4180` to the rest of the system?**
  _1 weakly-connected nodes found - possible missing edges._
- **Should `Telegram Bot Core` be split into smaller, more focused modules?**
  _Cohesion score 0.13157894736842105 - nodes in this community are weakly interconnected._
- **Why does `openai` connect `Package Dependencies Config` to `Telegram Bot Core`?**
  _High betweenness centrality (0.089) - this node is a cross-community bridge._
- **Are the 3 inferred relationships involving `buildCheckMessage()` (e.g. with `report.js` and `checkEventBlockEn()`) actually correct?**
  _`buildCheckMessage()` has 3 INFERRED edges - model-reasoned connections that need verification._
- **Why does `formatPeredachiReply()` connect `Peredachi Query Formatting` to `Telegram Bot Core`?**
  _High betweenness centrality (0.040) - this node is a cross-community bridge._