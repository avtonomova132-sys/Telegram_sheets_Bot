# Graph Report - Telegram_sheets_Bot  (2026-11-25)

## Corpus Check
- 116 files · ~177,409 words
- Verdict: corpus is large enough that graph structure adds value.
- Unclassified: 3 file(s) not represented in the graph (top: (none) 2, .example 1)

## Summary
- 1886 nodes · 5209 edges · 73 communities (68 shown, 5 thin omitted)
- Extraction: 86% EXTRACTED · 14% INFERRED · 0% AMBIGUOUS · INFERRED: 753 edges (avg confidence: 0.86)
- Token cost: 0 input · 0 output

## Graph Freshness
- Built from commit: `990efe44`
- Run `git rev-parse HEAD` and compare to check if the graph is stale.
- Run `graphify update .` after code changes (no API cost).

## Community Hubs (Navigation)
- cardButtons.js
- index.js
- dnevnik/view.js
- ref_fs
- ordersReport.js
- fotoFlow.js
- match.js
- hostAdmin.js
- feesWatch.js
- flow.js
- report.js
- training.js
- nomenclature.js
- peredachi/store.js
- assistantsSeries.js
- supplier.js
- fbo.js
- controlPoints.js
- disputes.js
- fboPlacement.js
- ozonMail.js
- escapeHtml
- dnevnik/store.js
- baliDateString
- nameMap.js
- test.js
- programNeeds.js
- returnsWatch.js
- split.js
- foto.test.js
- translate.js
- hostReminder.js
- articles.js
- barcode.js
- recognize.js
- events/store.js
- actionsGuard.js
- helpersApi.js
- groupLinks.js
- package.json
- assistance.js
- query.js
- items-parser.js
- onCallback
- progress.js
- xlsxFill.js
- generate_verse_image.py
- runOrdersReport
- parse.js
- handleText
- fetchReportRows
- proekty/view.js
- helperRoles.js
- tasksSheet.test.js
- disputes.test.js
- buildReport
- processPhoto
- readFirstSheet
- returnsWatch.test.js
- translate/store.js
- @anthropic-ai/sdk
- catalog.js
- classify
- events/extract.js
- fotoVision.js
- watch.js
- session-start.sh
- trivial.js
- gabarity/format.js
- ostatki_template_7ba9ef73.md
- .claude/CLAUDE.md

## God Nodes (most connected - your core abstractions)
1. `escapeHtml()` - 70 edges
2. `readJson()` - 44 edges
3. `Ozon: ежедневная форма (цвет, садовые бирки) — `ozon-form/index.js`` - 29 edges
4. `baliDateString()` - 29 edges
5. `sendToElena()` - 28 edges
6. `updateScheduler()` - 28 edges
7. `createAnnouncePreview()` - 26 edges
8. `mskDate()` - 26 edges
9. `dense()` - 26 edges
10. `collectWeekEvents()` - 25 edges

## Surprising Connections (you probably didn't know these)
- `Структура и что уже реализовано` --references--> `findFamilyByArticle()`  [INFERRED]
  CLAUDE.md → prihod/family.js
- `Структура и что уже реализовано` --references--> `firstWriteDone()`  [INFERRED]
  CLAUDE.md → prihod/fotoFlow.js
- `Структура и что уже реализовано` --references--> `articlesByBarcode()`  [INFERRED]
  CLAUDE.md → prihod/supplier.js
- `Шестиразовый дневник (`dnevnik/`) — самая активно дорабатываемая фича` --references--> `parseDnevnikBatch()`  [INFERRED]
  CLAUDE.md → dnevnik/parse.js
- `Шестиразовый дневник (`dnevnik/`) — самая активно дорабатываемая фича` --references--> `parseSinglePrincipleFallback()`  [INFERRED]
  CLAUDE.md → dnevnik/parse.js

## Import Cycles
- None detected.

## Communities (73 total, 5 thin omitted)

### Community 0 - "cardButtons.js"
Cohesion: 0.05
Nodes (158): ACKNOWLEDGED_DOUBTS, addCountedExtraForEvent(), addDaysUtc(), announceDiagnostics(), announceItems(), announceSignature(), announceSlotStep(), announceSummaryNote() (+150 more)

### Community 1 - "index.js"
Cohesion: 0.03
Nodes (45): EVENING_SUMMARY, formatSlotTime(), slotMinutes(), SLOTS, actionsKeyboard, app, bot, broadcastGroupIds (+37 more)

### Community 2 - "dnevnik/view.js"
Cohesion: 0.17
Nodes (31): Шестиразовый дневник (`dnevnik/`) — самая активно дорабатываемая фича, getMantra(), getPrinciple(), MANTRAS, PRINCIPLES, bold(), buildDayReport(), buildDayReportShort() (+23 more)

### Community 3 - "ref_fs"
Cohesion: 0.06
Nodes (47): baliDate(), BODY, fmtBali(), fs, init(), runScheduled(), tick(), path (+39 more)

### Community 4 - "ordersReport.js"
Cohesion: 0.09
Nodes (23): buildRows(), CMP_MONEY, crypto, csvHeader(), DATE_COLS, dateSerial(), dispCell(), ENRICH (+15 more)

### Community 5 - "fotoFlow.js"
Cohesion: 0.17
Nodes (19): deps, FILES, firstWriteDone(), fs, getBatch(), isSeen(), lastTotals(), markSeen() (+11 more)

### Community 6 - "match.js"
Cohesion: 0.13
Nodes (39): searchProducts(), baseNoWeight(), buildFamilies(), embeddedWeight(), findFamilyByArticle(), isArchived(), leadWeight(), parseArticleWeight() (+31 more)

### Community 7 - "hostAdmin.js"
Cohesion: 0.08
Nodes (56): ACTIVE_ROSTER, afterChange(), askHoldQuestions(), CONTEXTS, ctxByChat(), ctxFromArgs(), dayLabel(), elenaId() (+48 more)

### Community 8 - "feesWatch.js"
Cohesion: 0.06
Nodes (47): add(), ALWAYS, classify(), fs, list(), load(), norm(), path (+39 more)

### Community 9 - "flow.js"
Cohesion: 0.12
Nodes (46): isConfigured(), probeMessage(), askBadValue(), askNextAmbiguous(), askNextMark(), awaitingTemplate, build(), buildOstatki() (+38 more)

### Community 10 - "report.js"
Cohesion: 0.06
Nodes (57): RFC-4180, addDays(), azStartInstant(), BREAKFAST_MARKERS, buildTimeChangeHostNotice(), compactCheckDateLine(), compactCheckEventBlock(), CONFIG_PATH (+49 more)

### Community 11 - "training.js"
Cohesion: 0.15
Nodes (42): baliMondayKey(), BOOT_AT, chain, chunk5(), cleanTags(), confirm(), createPreview(), DEFAULT_TAGS (+34 more)

### Community 12 - "nomenclature.js"
Cohesion: 0.07
Nodes (46): AccessError, articleBlock(), buildAuthors(), buildMessages(), buildRenameMessages(), buildStatusMessage(), buildWeeklyMessage(), clean() (+38 more)

### Community 13 - "peredachi/store.js"
Cohesion: 0.12
Nodes (30): analyzeDuplicates(), completeness(), decideForAdd(), fieldValue(), hasConflict(), isSameEvent(), MATCH_FIELDS, checkReminders() (+22 more)

### Community 14 - "assistantsSeries.js"
Cohesion: 0.17
Nodes (24): findAssistanceColumns(), parseAssistanceEvents(), findAssistanceColumns(), findCommunityTag(), findTagForName(), parseSeriesAssistanceEvents(), cleanProgramLabel(), deriveMsk() (+16 more)

### Community 15 - "supplier.js"
Cohesion: 0.12
Nodes (29): normBarcode(), codesCoverage(), sendCoverage(), accountEmail(), articlesByBarcode(), buildIndex(), clean(), colLetter() (+21 more)

### Community 16 - "fbo.js"
Cohesion: 0.07
Nodes (64): buildMessage(), buildReport(), currentMessage(), dailyMessage(), debugMessage(), extractList(), fetchCatalog(), fetchPlacementFile() (+56 more)

### Community 17 - "controlPoints.js"
Cohesion: 0.06
Nodes (62): buildMessage(), clean(), fs, isRoutine(), lastReportTo(), money(), num(), parse() (+54 more)

### Community 18 - "disputes.js"
Cohesion: 0.13
Nodes (23): addFiledClaims(), applyFixes(), candidatesFromReturns(), expandClaims(), FIXES, formatCandidates(), formatEarly(), formatShort() (+15 more)

### Community 19 - "fboPlacement.js"
Cohesion: 0.14
Nodes (23): buildColumns(), buildDigest(), buildPaidMessage(), buildSummary(), clean(), describeReport(), num(), paidNow() (+15 more)

### Community 20 - "ozonMail.js"
Cohesion: 0.13
Nodes (22): buildAlert(), buildScript(), CATEGORIES, CATEGORY_LABEL, createHandler(), reportError(), crypto, express (+14 more)

### Community 21 - "escapeHtml"
Cohesion: 0.18
Nodes (28): reminderHeaderText(), urgentTexts(), buildCheckMessage(), buildCompactAllClosed(), buildCompactCheckBody(), buildThankYouHostMessage(), buildWeekCardParts(), buildWeeklyMessage() (+20 more)

### Community 22 - "dnevnik/store.js"
Cohesion: 0.15
Nodes (25): addSentSlot(), atomicWrite(), countPending(), fs, getByDateRange(), getById(), getDay(), getEveningSummaryDate() (+17 more)

### Community 23 - "baliDateString"
Cohesion: 0.09
Nodes (30): graphify, Maitreya — бот-помощник Elena, Ключевые архитектурные решения (сквозные, применены во всех модулях), Переменные окружения (Railway), Стек и деплой, baliMinutesNow(), checkActionsPeriodic(), checkAndRunFbo() (+22 more)

### Community 24 - "nameMap.js"
Cohesion: 0.26
Nodes (13): articleBase(), remember(), exactPattern(), fs, migrate(), path, read(), remember() (+5 more)

### Community 25 - "test.js"
Cohesion: 0.12
Nodes (20): distribute(), SET_SIZES, savePending(), buildPlan(), familyTotal(), parseQty(), pieceSize(), checkTotals() (+12 more)

### Community 26 - "programNeeds.js"
Cohesion: 0.09
Nodes (61): checkAndRunProgramsWatch(), runProgramsWatchCheck(), dayStr(), ddmmOf(), elenaId(), findTabFor(), handleCommand(), isElena() (+53 more)

### Community 27 - "returnsWatch.js"
Cohesion: 0.12
Nodes (24): fetchWriteoffsApi(), splitMessage(), classify(), debugSample(), fmtDate(), formatReport(), fs, getState() (+16 more)

### Community 28 - "split.js"
Cohesion: 0.53
Nodes (5): execRazdelit(), analyzeSplits(), isCombinedRecord(), splitRecord(), splitZanyatie()

### Community 29 - "foto.test.js"
Cohesion: 0.10
Nodes (18): assert, catalog, ctx, fakeEnv(), _fs, fs, fx(), _os (+10 more)

### Community 30 - "translate.js"
Cohesion: 0.17
Nodes (16): describeLanguages(), LANGUAGE_NAMES, LANGUAGE_ORDER, languageCodesUnion(), LANGUAGES, Anthropic, detectLanguage(), parseJsonResponse() (+8 more)

### Community 31 - "hostReminder.js"
Cohesion: 0.15
Nodes (25): checkAndSendHostReminder(), fs, handleReminderCallback(), path, processRefusal(), queues, readJson(), saveMessageRecord() (+17 more)

### Community 32 - "articles.js"
Cohesion: 0.19
Nodes (14): ARTICLE_HEADER_ALIASES, cleanValue(), findArticle(), findHeaderKey(), fs, NAME_HEADER_ALIASES, normalizeHeader(), parseArticlesBuffer() (+6 more)

### Community 33 - "barcode.js"
Cohesion: 0.15
Nodes (12): decode(), { execFile }, fs, os, parseZbar(), path, run(), fs (+4 more)

### Community 34 - "recognize.js"
Cohesion: 0.14
Nodes (22): Структура и что уже реализовано, applyQtyMark(), applyResults(), assemble(), finishCollecting(), numOrNull(), refineNone(), verifyReadings() (+14 more)

### Community 35 - "events/store.js"
Cohesion: 0.47
Nodes (5): addEvent(), fs, path, readAll(), writeAll()

### Community 36 - "actionsGuard.js"
Cohesion: 0.18
Nodes (15): csv(), fs, getState(), isIgnored(), lastIgnored, listActions(), listParticipants(), ozon() (+7 more)

### Community 37 - "helpersApi.js"
Cohesion: 0.18
Nodes (19): cellLink(), eventLink(), ALL_TIME, getData(), HELPERS_TABS, lev(), linksOf(), load() (+11 more)

### Community 38 - "groupLinks.js"
Cohesion: 0.10
Nodes (22): isTrustedUser(), trustedUserIds, execBezgruppy(), execDobavit(), execDubli(), execGruppy(), execObnovitSsylki(), execUdalit() (+14 more)

### Community 39 - "package.json"
Cohesion: 0.13
Nodes (19): dependencies, express@^4.19.2, node-cron@^3.0.3, node-telegram-bot-api@^0.66.0, openai@^4.52.0, xlsx@^0.18.5, description, engines (+11 more)

### Community 40 - "assistance.js"
Cohesion: 0.13
Nodes (44): ALLOWED_LANGUAGES, assistanceEventBlockEn(), assistanceEventBlockRu(), buildAssistanceMessage(), fetchAssistanceEvents(), generateAssistanceReport(), getVHousesTab(), inRange() (+36 more)

### Community 41 - "query.js"
Cohesion: 0.17
Nodes (26): execAssistenty(), execBlizhaishiy(), execCheckAssistants(), execData(), execKursDetail(), execKursy(), execMeditacii(), handleReportCommand() (+18 more)

### Community 42 - "items-parser.js"
Cohesion: 0.11
Nodes (24): handleTaskMessage(), Anthropic, buildSystemPrompt(), isConfigured, isKnownProject(), looksLikeTaskMessage(), parseTaskMessage(), PROJECT_KEYS (+16 more)

### Community 43 - "onCallback"
Cohesion: 0.25
Nodes (19): afterChange(), applyResolution(), ask(), famLabel(), finishBatch(), fixMenu(), fmt(), itemTitle() (+11 more)

### Community 44 - "progress.js"
Cohesion: 0.22
Nodes (16): checkAndSendDailyVerse(), execProgress(), execVerse(), sendVerseImage(), generateVerseImageBuffer(), applyForceOverride(), ensureProgressSeeded(), fs (+8 more)

### Community 45 - "xlsxFill.js"
Cohesion: 0.26
Nodes (17): cellStyle(), crc32(), decodeXml(), entryText(), escXml(), fillTemplate(), find(), locateSheet() (+9 more)

### Community 46 - "generate_verse_image.py"
Cohesion: 0.18
Nodes (4): _draw_tracked(), generate_verse_image(), _layout_content(), _wrap()

### Community 47 - "runOrdersReport"
Cohesion: 0.23
Nodes (16): loadServiceAccount(), colIndex(), colName(), compareSummary(), compareWithSheet(), dependenciesMessage(), getToken(), headersMessage() (+8 more)

### Community 48 - "parse.js"
Cohesion: 0.24
Nodes (13): Anthropic, buildBatchSystemPrompt(), callModelForArray(), extractJson(), extractJsonArray(), formatPrincipleForPrompt(), hasContent(), isConfigured (+5 more)

### Community 49 - "handleText"
Cohesion: 0.26
Nodes (13): chooseFamily(), enqueue(), fail(), handleDocument(), handlePhoto(), handleText(), init(), isTrusted() (+5 more)

### Community 50 - "fetchReportRows"
Cohesion: 0.33
Nodes (9): fetchPostingList(), fetchReportRows(), fillGeoFromGet(), flatten(), inspectPostings(), mskEnd(), mskStart(), ozonRaw() (+1 more)

### Community 51 - "proekty/view.js"
Cohesion: 0.27
Nodes (9): execPro(), ALL_ITEMS, isKnownItem(), ITEM_KEYS, SECTIONS, buildProKeyboard(), buildProMessage(), buildProText() (+1 more)

### Community 52 - "helperRoles.js"
Cohesion: 0.44
Nodes (9): clean(), countryCode(), extractRoles(), findLabelRow(), isContinuation(), isRecHeader(), nameOf(), norm() (+1 more)

### Community 53 - "tasksSheet.test.js"
Cohesion: 0.09
Nodes (40): checkTasksSheet(), AccessError, buildMessage(), check(), clean(), COLS, crypto, dueToday() (+32 more)

### Community 54 - "disputes.test.js"
Cohesion: 0.16
Nodes (13): addWriteoff(), approvalMessages(), markFiled(), markSent(), parseRuDate(), pickNew(), supportText(), assert (+5 more)

### Community 55 - "buildReport"
Cohesion: 0.27
Nodes (12): addDaysIso(), buildReport(), candidatesFromWriteoffs(), daysSince(), dropDuplicatesOfWriteoffs(), earlyWriteoffs(), filedClaimSet(), formatFiled() (+4 more)

### Community 56 - "processPhoto"
Cohesion: 0.24
Nodes (9): DATE_RES, findAuthor(), parseBareNumber(), parseCaption(), WORKERS, authorOf(), download(), getContext() (+1 more)

### Community 57 - "readFirstSheet"
Cohesion: 0.29
Nodes (9): colIndex(), decodeXml(), readFirstSheet(), readSharedStrings(), unzipEntries(), zlib, compareWithFile(), mskDay() (+1 more)

### Community 58 - "returnsWatch.test.js"
Cohesion: 0.25
Nodes (7): markSent(), pickNew(), ago(), assert, mk(), NOW, test

### Community 59 - "translate/store.js"
Cohesion: 0.43
Nodes (7): disable(), enable(), fs, isEnabled(), path, readAll(), writeAll()

### Community 60 - "@anthropic-ai/sdk"
Cohesion: 0.33
Nodes (6): analyzePhoto(), Anthropic, guessMediaType(), KNOWN_AXES, @anthropic-ai/sdk@^0.116.0, @anthropic-ai/sdk

### Community 61 - "catalog.js"
Cohesion: 0.43
Nodes (6): fetchLive(), fs, getCatalog(), path, readCache(), writeCache()

### Community 62 - "classify"
Cohesion: 0.50
Nodes (4): Anthropic, classify(), getClient(), parseClassification()

### Community 63 - "events/extract.js"
Cohesion: 0.15
Nodes (13): FORMATS, PROGRAMS, Anthropic, extractEvent(), buildConfirmationText(), FORMAT_LABELS_RU, formatDateRu(), MONTHS_RU (+5 more)

### Community 64 - "fotoVision.js"
Cohesion: 0.47
Nodes (5): Anthropic, call(), costOf(), PRICE, readLabel()

### Community 65 - "watch.js"
Cohesion: 0.53
Nodes (5): getWatchedGroupIds(), hasCourseMention(), hasDateMention(), hasTimeMention(), looksLikeAnnouncement()

### Community 67 - "trivial.js"
Cohesion: 0.50
Nodes (4): isTrivialMessage(), normalize(), TRIVIAL_PHRASES, TRIVIAL_SET

### Community 68 - "gabarity/format.js"
Cohesion: 0.83
Nodes (3): buildResultText(), cmToMm(), kgToG()

## Knowledge Gaps
- **1 isolated node(s):** `RFC-4180`
  These have ≤1 connection - possible missing edges or undocumented components. (Counts symbols only; 413 node(s) total have ≤1 connection when file, concept and rationale nodes are included.)
- **5 thin communities (<3 nodes) omitted from report** — run `graphify query` to explore isolated nodes.

## Suggested Questions
_Questions this graph is uniquely positioned to answer:_

- **Why does `sendParts()` connect `controlPoints.js` to `index.js`, `ref_fs`, `tasksSheet.test.js`, `baliDateString`?**
  _High betweenness centrality (0.013) - this node is a cross-community bridge._
- **Are the 3 inferred relationships involving `escapeHtml()` (e.g. with `report.js` and `partialDataWarningEn()`) actually correct?**
  _`escapeHtml()` has 3 INFERRED edges - model-reasoned connections that need verification._
- **What connects `RFC-4180` to the rest of the system?**
  _1 weakly-connected nodes found - possible documentation gaps or missing edges._
- **Should `cardButtons.js` be split into smaller, more focused modules?**
  _Cohesion score 0.05429504020380543 - nodes in this community are weakly interconnected._
- **Why does `Maitreya — бот-помощник Elena` connect `baliDateString` to `cardButtons.js`, `recognize.js`?**
  _High betweenness centrality (0.012) - this node is a cross-community bridge._
- **Are the 28 inferred relationships involving `Ozon: ежедневная форма (цвет, садовые бирки) — `ozon-form/index.js`` (e.g. with `lastReportTo()` and `announceDiagnostics()`) actually correct?**
  _`Ozon: ежедневная форма (цвет, садовые бирки) — `ozon-form/index.js`` has 28 INFERRED edges - model-reasoned connections that need verification._
- **Should `index.js` be split into smaller, more focused modules?**
  _Cohesion score 0.02962962962962963 - nodes in this community are weakly interconnected._