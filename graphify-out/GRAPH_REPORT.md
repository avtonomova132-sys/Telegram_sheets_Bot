# Graph Report - Telegram_sheets_Bot  (2026-11-25)

## Corpus Check
- 115 files · ~176,200 words
- Verdict: corpus is large enough that graph structure adds value.
- Unclassified: 3 file(s) not represented in the graph (top: (none) 2, .example 1)

## Summary
- 1872 nodes · 5173 edges · 71 communities (67 shown, 4 thin omitted)
- Extraction: 86% EXTRACTED · 14% INFERRED · 0% AMBIGUOUS · INFERRED: 750 edges (avg confidence: 0.86)
- Token cost: 0 input · 0 output

## Graph Freshness
- Built from commit: `6f9897d2`
- Run `git rev-parse HEAD` and compare to check if the graph is stale.
- Run `graphify update .` after code changes (no API cost).

## Community Hubs (Navigation)
- cardButtons.js
- index.js
- baliDateString
- ozonReminders.test.js
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
- assistantsSeries.js
- formatDDMM
- baliDateString
- nameMap.js
- test.js
- programNeeds.js
- returnsWatch.js
- chunkMessage
- feesKnown.test.js
- translate.js
- hostReminder.js
- articles.js
- barcode.js
- recognize.js
- ref_path
- actionsGuard.js
- ozon-form/index.js
- groupLinks.js
- package.json
- assistance.js
- query.js
- items-parser.js
- ref_fs
- progress.js
- xlsxFill.js
- generate_verse_image.py
- runOrdersReport
- ozonMsg.js
- accrualsReport.js
- fetchReportRows
- proekty/view.js
- helperRoles.js
- tasksSheet.test.js
- disputes.test.js
- buildReport
- ozonMsg.test.js
- readFirstSheet
- returnsWatch.test.js
- translate/store.js
- @anthropic-ai/sdk
- Maitreya — Telegram-бот Елены
- classify
- events/extract.js
- watch.js
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
- `На что обратить внимание при доработках` --references--> `baliDateString()`  [INFERRED]
  CLAUDE.md → verse/progress.js
- `На что обратить внимание при доработках` --references--> `baliHour()`  [INFERRED]
  CLAUDE.md → verse/progress.js

## Import Cycles
- None detected.

## Communities (71 total, 4 thin omitted)

### Community 0 - "cardButtons.js"
Cohesion: 0.05
Nodes (169): ACKNOWLEDGED_DOUBTS, addCountedExtraForEvent(), addDaysUtc(), announceDiagnostics(), announceItems(), announceSignature(), announceSlotStep(), announceSummaryNote() (+161 more)

### Community 1 - "index.js"
Cohesion: 0.03
Nodes (43): EVENING_SUMMARY, formatSlotTime(), slotMinutes(), SLOTS, actionsKeyboard, app, bot, broadcastGroupIds (+35 more)

### Community 2 - "baliDateString"
Cohesion: 0.07
Nodes (70): Шестиразовый дневник (`dnevnik/`) — самая активно дорабатываемая фича, Anthropic, buildBatchSystemPrompt(), callModelForArray(), extractJson(), extractJsonArray(), formatPrincipleForPrompt(), hasContent() (+62 more)

### Community 3 - "ozonReminders.test.js"
Cohesion: 0.16
Nodes (19): checkOzonReminders(), add(), dueNow(), format(), fs, list(), load(), markSent() (+11 more)

### Community 4 - "ordersReport.js"
Cohesion: 0.10
Nodes (22): buildRows(), CMP_MONEY, compareSummary(), crypto, DATE_COLS, dateSerial(), dispCell(), ENRICH (+14 more)

### Community 5 - "fotoFlow.js"
Cohesion: 0.06
Nodes (82): assert, catalog, ctx, fakeEnv(), _fs, fs, fx(), _os (+74 more)

### Community 6 - "match.js"
Cohesion: 0.11
Nodes (40): normBarcode(), fs, path, searchProducts(), findFamilyByArticle(), barcodeKey(), buildText(), fmtMove() (+32 more)

### Community 7 - "hostAdmin.js"
Cohesion: 0.08
Nodes (56): ACTIVE_ROSTER, afterChange(), askHoldQuestions(), CONTEXTS, ctxByChat(), ctxFromArgs(), dayLabel(), elenaId() (+48 more)

### Community 8 - "feesWatch.js"
Cohesion: 0.10
Nodes (29): accrualsForDay(), addDays(), amountOf(), collectFees(), dateOf(), dayStr(), debugSample(), dm() (+21 more)

### Community 9 - "flow.js"
Cohesion: 0.12
Nodes (47): isConfigured(), probeMessage(), applyQtyMark(), askBadValue(), askNextAmbiguous(), askNextMark(), awaitingTemplate, build() (+39 more)

### Community 10 - "report.js"
Cohesion: 0.05
Nodes (69): RFC-4180, addDays(), azStartInstant(), BREAKFAST_MARKERS, buildAllCoveredMessage(), buildCheckMessage(), buildCompactAllClosed(), buildCompactCheckBody() (+61 more)

### Community 11 - "training.js"
Cohesion: 0.15
Nodes (42): baliMondayKey(), BOOT_AT, chain, chunk5(), cleanTags(), confirm(), createPreview(), DEFAULT_TAGS (+34 more)

### Community 12 - "nomenclature.js"
Cohesion: 0.05
Nodes (65): AccessError, articleBlock(), buildAuthors(), buildMessages(), buildRenameMessages(), buildStatusMessage(), buildWeeklyMessage(), clean() (+57 more)

### Community 13 - "peredachi/store.js"
Cohesion: 0.17
Nodes (23): analyzeDuplicates(), completeness(), decideForAdd(), fieldValue(), hasConflict(), isSameEvent(), MATCH_FIELDS, extractNumbers() (+15 more)

### Community 14 - "assistantsSeries.js"
Cohesion: 0.17
Nodes (23): findAssistanceColumns(), parseAssistanceEvents(), findAssistanceColumns(), parseSeriesAssistanceEvents(), cleanProgramLabel(), deriveMsk(), fallbackTitle(), findHeaderSegments() (+15 more)

### Community 15 - "supplier.js"
Cohesion: 0.13
Nodes (27): codesCoverage(), sendCoverage(), accountEmail(), articlesByBarcode(), buildIndex(), clean(), colLetter(), COLS (+19 more)

### Community 16 - "fbo.js"
Cohesion: 0.07
Nodes (64): buildMessage(), buildReport(), currentMessage(), dailyMessage(), debugMessage(), extractList(), fetchCatalog(), fetchPlacementFile() (+56 more)

### Community 17 - "controlPoints.js"
Cohesion: 0.19
Nodes (19): add(), closeByReport(), DETAIL_HOW, done(), dueNow(), formatSupport(), fs, load() (+11 more)

### Community 18 - "disputes.js"
Cohesion: 0.16
Nodes (20): addFiledClaims(), applyFixes(), expandClaims(), FIXES, formatCandidates(), formatEarly(), formatShort(), fs (+12 more)

### Community 19 - "fboPlacement.js"
Cohesion: 0.15
Nodes (23): buildColumns(), buildDigest(), buildPaidMessage(), buildSummary(), clean(), describeReport(), num(), paidNow() (+15 more)

### Community 20 - "ozonMail.js"
Cohesion: 0.13
Nodes (22): buildAlert(), buildScript(), CATEGORIES, CATEGORY_LABEL, createHandler(), reportError(), crypto, express (+14 more)

### Community 21 - "assistantsSeries.js"
Cohesion: 0.14
Nodes (26): fetchAssistanceEvents(), getVHousesTab(), ALLOWED_LANGUAGES, buildNameTagMap(), buildSeriesCheckMessage(), fetchSeriesAssistanceEvents(), findCommunityTag(), findTagForName() (+18 more)

### Community 22 - "formatDDMM"
Cohesion: 0.33
Nodes (6): compactCheckDateLine(), compactCheckEventBlock(), formatDDMM(), hostReminderTimeLine(), sundayButtonWhen(), sundayProgramName()

### Community 23 - "baliDateString"
Cohesion: 0.12
Nodes (27): Ключевые архитектурные решения (сквозные, применены во всех модулях), checkActionsPeriodic(), checkAndRunFbo(), checkAndRunMargin(), checkAndRunNomenclature(), checkAndRunPlacement(), checkAndRunProgramsWatch(), checkControlPoints() (+19 more)

### Community 24 - "nameMap.js"
Cohesion: 0.16
Nodes (22): articleBase(), baseNoWeight(), buildFamilies(), embeddedWeight(), isArchived(), leadWeight(), parseArticleWeight(), parsePieces() (+14 more)

### Community 25 - "test.js"
Cohesion: 0.15
Nodes (16): distribute(), buildReport(), checkTotals(), computePlan(), near(), status(), assert, catalog (+8 more)

### Community 26 - "programNeeds.js"
Cohesion: 0.07
Nodes (71): cellLink(), eventLink(), ALL_TIME, getData(), HELPERS_TABS, lev(), linksOf(), load() (+63 more)

### Community 27 - "returnsWatch.js"
Cohesion: 0.12
Nodes (24): fetchWriteoffsApi(), splitMessage(), classify(), debugSample(), fmtDate(), formatReport(), fs, getState() (+16 more)

### Community 28 - "chunkMessage"
Cohesion: 0.11
Nodes (22): isTrustedUser(), trustedUserIds, execAssistenty(), execBezgruppy(), execBlizhaishiy(), execCheckAssistants(), execDubli(), execKursDetail() (+14 more)

### Community 29 - "feesKnown.test.js"
Cohesion: 0.16
Nodes (18): add(), ALWAYS, classify(), fs, list(), load(), norm(), path (+10 more)

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
Cohesion: 0.10
Nodes (29): graphify, Maitreya — бот-помощник Elena, Переменные окружения (Railway), Стек и деплой, Структура и что уже реализовано, fetchLive(), getCatalog(), readCache() (+21 more)

### Community 35 - "ref_path"
Cohesion: 0.19
Nodes (11): addEvent(), fs, path, readAll(), writeAll(), fs, getDay(), path (+3 more)

### Community 36 - "actionsGuard.js"
Cohesion: 0.18
Nodes (15): csv(), fs, getState(), isIgnored(), lastIgnored, listActions(), listParticipants(), ozon() (+7 more)

### Community 37 - "ozon-form/index.js"
Cohesion: 0.32
Nodes (13): baliDate(), BODY, fmtBali(), fs, init(), runScheduled(), tick(), path (+5 more)

### Community 38 - "groupLinks.js"
Cohesion: 0.16
Nodes (17): execDobavit(), execGruppy(), execObnovitSsylki(), Anthropic, extractPeredachi(), ensureGroupLinksSeeded(), extractInternalGroupId(), fs (+9 more)

### Community 39 - "package.json"
Cohesion: 0.13
Nodes (19): dependencies, express@^4.19.2, node-cron@^3.0.3, node-telegram-bot-api@^0.66.0, openai@^4.52.0, xlsx@^0.18.5, description, engines (+11 more)

### Community 40 - "assistance.js"
Cohesion: 0.18
Nodes (29): ALLOWED_LANGUAGES, assistanceEventBlockEn(), assistanceEventBlockRu(), buildAssistanceMessage(), generateAssistanceReport(), inRange(), languageLineEn(), languageLineRu() (+21 more)

### Community 41 - "query.js"
Cohesion: 0.17
Nodes (25): execData(), escapeMarkdown(), extractCourseNumbers(), formatByDate(), formatDateRu(), formatKursDetail(), formatKursOverview(), formatMeditations() (+17 more)

### Community 42 - "items-parser.js"
Cohesion: 0.16
Nodes (16): execZadachi(), handleTaskMessage(), Anthropic, buildSystemPrompt(), isConfigured, isKnownProject(), looksLikeTaskMessage(), parseTaskMessage() (+8 more)

### Community 43 - "ref_fs"
Cohesion: 0.36
Nodes (9): addTask(), buildDatetime(), fs, generateId(), getOpenTasks(), markDone(), path, readAll() (+1 more)

### Community 44 - "progress.js"
Cohesion: 0.22
Nodes (16): checkAndSendDailyVerse(), execProgress(), execVerse(), sendVerseImage(), generateVerseImageBuffer(), applyForceOverride(), ensureProgressSeeded(), fs (+8 more)

### Community 45 - "xlsxFill.js"
Cohesion: 0.28
Nodes (16): cellStyle(), crc32(), decodeXml(), entryText(), escXml(), fillTemplate(), find(), locateSheet() (+8 more)

### Community 46 - "generate_verse_image.py"
Cohesion: 0.18
Nodes (4): _draw_tracked(), generate_verse_image(), _layout_content(), _wrap()

### Community 47 - "runOrdersReport"
Cohesion: 0.29
Nodes (13): loadServiceAccount(), colIndex(), colName(), compareWithSheet(), dependenciesMessage(), getToken(), headersMessage(), readRange() (+5 more)

### Community 48 - "ozonMsg.js"
Cohesion: 0.21
Nodes (16): send(), addDays(), codeBlocks(), dm(), esc(), installMarker(), isOzonText(), mark() (+8 more)

### Community 49 - "accrualsReport.js"
Cohesion: 0.23
Nodes (14): buildMessage(), clean(), fs, isRoutine(), lastReportTo(), money(), num(), parse() (+6 more)

### Community 50 - "fetchReportRows"
Cohesion: 0.22
Nodes (13): csvHeader(), fetchPostingList(), fetchReportRows(), fillGeoFromGet(), flatten(), inspectPostings(), mskEnd(), mskStart() (+5 more)

### Community 51 - "proekty/view.js"
Cohesion: 0.27
Nodes (9): execPro(), ALL_ITEMS, isKnownItem(), ITEM_KEYS, SECTIONS, buildProKeyboard(), buildProMessage(), buildProText() (+1 more)

### Community 52 - "helperRoles.js"
Cohesion: 0.44
Nodes (9): clean(), countryCode(), extractRoles(), findLabelRow(), isContinuation(), isRecHeader(), nameOf(), norm() (+1 more)

### Community 53 - "tasksSheet.test.js"
Cohesion: 0.20
Nodes (8): A, assert, B, fs, H, os, path, test

### Community 54 - "disputes.test.js"
Cohesion: 0.13
Nodes (17): addWriteoff(), approvalMessages(), candidatesFromReturns(), markFiled(), markSent(), msToIso(), parseRuDate(), pickNew() (+9 more)

### Community 55 - "buildReport"
Cohesion: 0.31
Nodes (11): addDaysIso(), buildReport(), candidatesFromWriteoffs(), daysSince(), dropDuplicatesOfWriteoffs(), earlyWriteoffs(), filedClaimSet(), formatFiled() (+3 more)

### Community 56 - "ozonMsg.test.js"
Cohesion: 0.19
Nodes (12): fmtDate(), format(), formatDone(), list(), whyOf(), build(), assert, dir (+4 more)

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

### Community 61 - "Maitreya — Telegram-бот Елены"
Cohesion: 0.33
Nodes (5): Maitreya — Telegram-бот Елены, Напоминания Ozon для Claude, Правило для сообщений про Озон (обязательно для любой новой ветки), Списания Ozon: что бот не считает новым, Таблица заданий для Елены

### Community 62 - "classify"
Cohesion: 0.50
Nodes (4): Anthropic, classify(), getClient(), parseClassification()

### Community 63 - "events/extract.js"
Cohesion: 0.15
Nodes (13): FORMATS, PROGRAMS, Anthropic, extractEvent(), buildConfirmationText(), FORMAT_LABELS_RU, formatDateRu(), MONTHS_RU (+5 more)

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
  These have ≤1 connection - possible missing edges or undocumented components. (Counts symbols only; 406 node(s) total have ≤1 connection when file, concept and rationale nodes are included.)
- **4 thin communities (<3 nodes) omitted from report** — run `graphify query` to explore isolated nodes.

## Suggested Questions
_Questions this graph is uniquely positioned to answer:_

- **Why does `Maitreya — бот-помощник Elena` connect `recognize.js` to `cardButtons.js`, `baliDateString`?**
  _High betweenness centrality (0.012) - this node is a cross-community bridge._
- **Are the 3 inferred relationships involving `escapeHtml()` (e.g. with `report.js` and `partialDataWarningEn()`) actually correct?**
  _`escapeHtml()` has 3 INFERRED edges - model-reasoned connections that need verification._
- **What connects `RFC-4180` to the rest of the system?**
  _1 weakly-connected nodes found - possible documentation gaps or missing edges._
- **Should `cardButtons.js` be split into smaller, more focused modules?**
  _Cohesion score 0.052001392272885485 - nodes in this community are weakly interconnected._
- **Why does `На что обратить внимание при доработках` connect `cardButtons.js` to `recognize.js`, `hostAdmin.js`, `training.js`, `assistantsSeries.js`, `baliDateString`, `programNeeds.js`, `hostReminder.js`?**
  _High betweenness centrality (0.007) - this node is a cross-community bridge._
- **Are the 28 inferred relationships involving `Ozon: ежедневная форма (цвет, садовые бирки) — `ozon-form/index.js`` (e.g. with `lastReportTo()` and `announceDiagnostics()`) actually correct?**
  _`Ozon: ежедневная форма (цвет, садовые бирки) — `ozon-form/index.js`` has 28 INFERRED edges - model-reasoned connections that need verification._
- **Should `index.js` be split into smaller, more focused modules?**
  _Cohesion score 0.03050957481337228 - nodes in this community are weakly interconnected._