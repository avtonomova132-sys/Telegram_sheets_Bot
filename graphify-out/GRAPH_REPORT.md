# Graph Report - Telegram_sheets_Bot  (2026-11-25)

## Corpus Check
- 115 files · ~175,466 words
- Verdict: corpus is large enough that graph structure adds value.
- Unclassified: 3 file(s) not represented in the graph (top: (none) 2, .example 1)

## Summary
- 1869 nodes · 5344 edges · 73 communities (69 shown, 4 thin omitted)
- Extraction: 86% EXTRACTED · 14% INFERRED · 0% AMBIGUOUS · INFERRED: 748 edges (avg confidence: 0.86)
- Token cost: 0 input · 0 output

## Graph Freshness
- Built from commit: `b9dbac08`
- Run `git rev-parse HEAD` and compare to check if the graph is stale.
- Run `graphify update .` after code changes (no API cost).

## Community Hubs (Navigation)
- cardButtons.js
- index.js
- baliDateString
- ref_path
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
- margin.js
- controlPoints.js
- disputes.js
- fboPlacement.js
- ozonMail.js
- sheet.js
- mskDate
- fbo.js
- escapeHtml
- test.js
- programNeeds.js
- returnsWatch.js
- chunkMessage
- programRules.js
- translate.js
- hostReminder.js
- articles.js
- tasksSheet.js
- recognize.js
- foto.test.js
- actionsGuard.js
- helpersApi.js
- groupLinks.js
- package.json
- assistance.js
- query.js
- items-parser.js
- ref_fs
- progress.js
- xlsxFill.js
- generate_verse_image.py
- programsWatch.js
- ozonMsg.js
- accrualsReport.js
- ozonPost
- proekty/view.js
- helperRoles.js
- tasksSheet.test.js
- disputes.test.js
- checkDisputesPeriodic
- ozonMsg.test.js
- ozonStock.js
- returnsWatch.test.js
- translate/store.js
- @anthropic-ai/sdk
- collectDisputeReport
- formatShort
- events/extract.js
- events/format.js
- watch.js
- fotoVision.js
- trivial.js
- gabarity/format.js
- ostatki_template_7ba9ef73.md
- .claude/CLAUDE.md

## God Nodes (most connected - your core abstractions)
1. `escapeHtml()` - 70 edges
2. `readJson()` - 44 edges
3. `baliDateString()` - 29 edges
4. `sendToElena()` - 28 edges
5. `updateScheduler()` - 28 edges
6. `Ozon: ежедневная форма (цвет, садовые бирки) — `ozon-form/index.js`` - 28 edges
7. `createAnnouncePreview()` - 26 edges
8. `dense()` - 26 edges
9. `mskDate()` - 26 edges
10. `collectWeekEvents()` - 25 edges

## Surprising Connections (you probably didn't know these)
- `Структура и что уже реализовано` --references--> `findFamilyByArticle()`  [INFERRED]
  CLAUDE.md → prihod/family.js
- `Структура и что уже реализовано` --references--> `prepareLine()`  [INFERRED]
  CLAUDE.md → prihod/recognize.js
- `На что обратить внимание при доработках` --references--> `baliDateString()`  [INFERRED]
  CLAUDE.md → verse/progress.js
- `Ключевые архитектурные решения (сквозные, применены во всех модулях)` --references--> `baliHour()`  [INFERRED]
  CLAUDE.md → verse/progress.js
- `На что обратить внимание при доработках` --references--> `baliHour()`  [INFERRED]
  CLAUDE.md → verse/progress.js

## Import Cycles
- None detected.

## Communities (73 total, 4 thin omitted)

### Community 0 - "cardButtons.js"
Cohesion: 0.05
Nodes (162): ACKNOWLEDGED_DOUBTS, addCountedExtraForEvent(), addDaysUtc(), announceDiagnostics(), announceItems(), announceSignature(), announceSlotStep(), announceSummaryNote() (+154 more)

### Community 1 - "index.js"
Cohesion: 0.03
Nodes (48): baliMinutesNow(), EVENING_SUMMARY, formatSlotTime(), slotMinutes(), SLOTS, extractEvent(), fillTimezones(), shiftTime() (+40 more)

### Community 2 - "baliDateString"
Cohesion: 0.06
Nodes (75): graphify, Maitreya — бот-помощник Elena, Ключевые архитектурные решения (сквозные, применены во всех модулях), Переменные окружения (Railway), Стек и деплой, Шестиразовый дневник (`dnevnik/`) — самая активно дорабатываемая фича, Anthropic, buildBatchSystemPrompt() (+67 more)

### Community 3 - "ref_path"
Cohesion: 0.05
Nodes (54): checkOzonReminders(), baliDate(), BODY, fmtBali(), fs, init(), runScheduled(), tick() (+46 more)

### Community 4 - "ordersReport.js"
Cohesion: 0.07
Nodes (56): colIndex(), decodeXml(), readFirstSheet(), readSharedStrings(), unzipEntries(), zlib, buildRows(), CMP_MONEY (+48 more)

### Community 5 - "fotoFlow.js"
Cohesion: 0.09
Nodes (60): DATE_RES, findAuthor(), parseBareNumber(), parseCaption(), WORKERS, afterChange(), applyResolution(), ask() (+52 more)

### Community 6 - "match.js"
Cohesion: 0.09
Nodes (53): normBarcode(), fs, path, searchProducts(), articleBase(), baseNoWeight(), buildFamilies(), embeddedWeight() (+45 more)

### Community 7 - "hostAdmin.js"
Cohesion: 0.08
Nodes (56): ACTIVE_ROSTER, afterChange(), askHoldQuestions(), CONTEXTS, ctxByChat(), ctxFromArgs(), dayLabel(), elenaId() (+48 more)

### Community 8 - "feesWatch.js"
Cohesion: 0.07
Nodes (52): add(), ALWAYS, classify(), fs, list(), load(), norm(), path (+44 more)

### Community 9 - "flow.js"
Cohesion: 0.11
Nodes (49): isConfigured(), getCatalog(), readCache(), writeCache(), applyQtyMark(), askBadValue(), askNextAmbiguous(), askNextMark() (+41 more)

### Community 10 - "report.js"
Cohesion: 0.06
Nodes (46): RFC-4180, azStartInstant(), baliNow(), BREAKFAST_MARKERS, buildThankYouHostMessage(), buildTimeChangeHostNotice(), CONFIG_PATH, DAILY_CHECK_TABS_PATH (+38 more)

### Community 11 - "training.js"
Cohesion: 0.14
Nodes (43): trainingTick(), baliMondayKey(), BOOT_AT, chain, chunk5(), cleanTags(), confirm(), createPreview() (+35 more)

### Community 12 - "nomenclature.js"
Cohesion: 0.09
Nodes (37): checkAndRunNomenclature(), nomenclatureRecipients(), runNomenclatureCheck(), articleBlock(), buildAuthors(), buildLongMessage(), buildMessages(), buildRenameMessages() (+29 more)

### Community 13 - "peredachi/store.js"
Cohesion: 0.12
Nodes (30): analyzeDuplicates(), completeness(), decideForAdd(), fieldValue(), hasConflict(), isSameEvent(), MATCH_FIELDS, checkReminders() (+22 more)

### Community 14 - "assistantsSeries.js"
Cohesion: 0.13
Nodes (31): findAssistanceColumns(), parseAssistanceEvents(), ALLOWED_LANGUAGES, buildNameTagMap(), buildSeriesCheckMessage(), findAssistanceColumns(), findCommunityTag(), findTagForName() (+23 more)

### Community 15 - "supplier.js"
Cohesion: 0.11
Nodes (30): Структура и что уже реализовано, codesCoverage(), sendCoverage(), firstWriteDone(), accountEmail(), articlesByBarcode(), buildIndex(), clean() (+22 more)

### Community 16 - "margin.js"
Cohesion: 0.13
Nodes (30): checkAndRunMargin(), marginRecipients(), buildMessage(), COMMISSION_TIERS, compactLine(), currentMessage(), dailyMessage(), debugMessage() (+22 more)

### Community 17 - "controlPoints.js"
Cohesion: 0.15
Nodes (28): add(), closeByReport(), DETAIL_HOW, done(), dueNow(), fmtDate(), format(), formatDone() (+20 more)

### Community 18 - "disputes.js"
Cohesion: 0.15
Nodes (27): addDaysIso(), addFiledClaims(), addWriteoff(), buildReport(), candidatesFromWriteoffs(), daysSince(), dropDuplicatesOfWriteoffs(), earlyWriteoffs() (+19 more)

### Community 19 - "fboPlacement.js"
Cohesion: 0.14
Nodes (24): buildColumns(), buildDigest(), buildPaidMessage(), buildSummary(), clean(), describeReport(), num(), paidNow() (+16 more)

### Community 20 - "ozonMail.js"
Cohesion: 0.12
Nodes (26): Anthropic, buildAlert(), buildScript(), CATEGORIES, CATEGORY_LABEL, classify(), createHandler(), reportError() (+18 more)

### Community 21 - "sheet.js"
Cohesion: 0.15
Nodes (23): fetchAssistanceEvents(), getVHousesTab(), fetchSeriesAssistanceEvents(), getSeriesTab(), AccessError, fetchEditors(), fetchRows(), fetchWithTimeout2() (+15 more)

### Community 22 - "mskDate"
Cohesion: 0.15
Nodes (27): eventBlockRu(), buildTuesdayMessages(), hostMessageText(), hostsNeededPhrase(), nudgeEventBlocks(), urgentTexts(), addDays(), checkEventBlockRu() (+19 more)

### Community 23 - "fbo.js"
Cohesion: 0.14
Nodes (26): buildMessage(), buildReport(), currentMessage(), dailyMessage(), debugMessage(), fetchPlacementFile(), FOOD_KEYWORDS, formatRub() (+18 more)

### Community 24 - "escapeHtml"
Cohesion: 0.19
Nodes (26): reminderHeaderText(), buildAllCoveredMessage(), buildCheckMessage(), buildCompactAllClosed(), buildCompactCheckBody(), buildWeekCardParts(), buildWeeklyMessage(), checkEventLine() (+18 more)

### Community 25 - "test.js"
Cohesion: 0.12
Nodes (22): distribute(), SET_SIZES, sizeCode(), buildPlan(), buildText(), familyTotal(), parseQty(), parseRange() (+14 more)

### Community 26 - "programNeeds.js"
Cohesion: 0.21
Nodes (24): dayStr(), ddmmOf(), elenaId(), findTabFor(), handleCommand(), isElena(), listSheetTabs(), newTabsStep() (+16 more)

### Community 27 - "returnsWatch.js"
Cohesion: 0.15
Nodes (23): checkReturnsWeekly(), classify(), debugSample(), fmtDate(), formatReport(), fs, getState(), GROUPS (+15 more)

### Community 28 - "chunkMessage"
Cohesion: 0.11
Nodes (21): isTrustedUser(), trustedUserIds, execAssistenty(), execBezgruppy(), execBlizhaishiy(), execCheckAssistants(), execDubli(), execKursDetail() (+13 more)

### Community 29 - "programRules.js"
Cohesion: 0.17
Nodes (22): normTab(), onTabCallback(), addWhitelistTab(), blockTab(), defaultTabs(), dynamicTabs(), FILE(), findExcluded() (+14 more)

### Community 30 - "translate.js"
Cohesion: 0.17
Nodes (16): describeLanguages(), LANGUAGE_NAMES, LANGUAGE_ORDER, languageCodesUnion(), LANGUAGES, Anthropic, detectLanguage(), parseJsonResponse() (+8 more)

### Community 31 - "hostReminder.js"
Cohesion: 0.18
Nodes (21): checkAndSendHostReminder(), fs, handleReminderCallback(), path, processRefusal(), queues, readJson(), saveMessageRecord() (+13 more)

### Community 32 - "articles.js"
Cohesion: 0.13
Nodes (20): ARTICLE_HEADER_ALIASES, cleanValue(), findArticle(), findHeaderKey(), fs, NAME_HEADER_ALIASES, normalizeHeader(), parseArticlesBuffer() (+12 more)

### Community 33 - "tasksSheet.js"
Cohesion: 0.19
Nodes (20): checkTasksSheet(), AccessError, buildMessage(), check(), clean(), COLS, diff(), dueToday() (+12 more)

### Community 34 - "recognize.js"
Cohesion: 0.16
Nodes (20): applyResults(), assemble(), finishCollecting(), numOrNull(), refineNone(), verifyReadings(), Anthropic, arithmeticOk() (+12 more)

### Community 35 - "foto.test.js"
Cohesion: 0.10
Nodes (18): assert, catalog, ctx, fakeEnv(), _fs, fs, fx(), _os (+10 more)

### Community 36 - "actionsGuard.js"
Cohesion: 0.19
Nodes (19): csv(), formatSnapshot(), fs, getState(), isConfigured(), isIgnored(), lastIgnored, listActions() (+11 more)

### Community 37 - "helpersApi.js"
Cohesion: 0.18
Nodes (19): cellLink(), eventLink(), ALL_TIME, getData(), HELPERS_TABS, lev(), linksOf(), load() (+11 more)

### Community 38 - "groupLinks.js"
Cohesion: 0.16
Nodes (17): execDobavit(), execGruppy(), execObnovitSsylki(), Anthropic, extractPeredachi(), ensureGroupLinksSeeded(), extractInternalGroupId(), fs (+9 more)

### Community 39 - "package.json"
Cohesion: 0.13
Nodes (19): dependencies, express@^4.19.2, node-cron@^3.0.3, node-telegram-bot-api@^0.66.0, openai@^4.52.0, xlsx@^0.18.5, description, engines (+11 more)

### Community 40 - "assistance.js"
Cohesion: 0.23
Nodes (18): ALLOWED_LANGUAGES, assistanceEventBlockEn(), assistanceEventBlockRu(), buildAssistanceMessage(), generateAssistanceReport(), inRange(), languageLineEn(), languageLineRu() (+10 more)

### Community 41 - "query.js"
Cohesion: 0.28
Nodes (18): execData(), escapeMarkdown(), extractCourseNumbers(), formatByDate(), formatDateRu(), formatKursDetail(), formatKursOverview(), formatMeditations() (+10 more)

### Community 42 - "items-parser.js"
Cohesion: 0.16
Nodes (16): execZadachi(), handleTaskMessage(), Anthropic, buildSystemPrompt(), isConfigured, isKnownProject(), looksLikeTaskMessage(), parseTaskMessage() (+8 more)

### Community 43 - "ref_fs"
Cohesion: 0.18
Nodes (14): addEvent(), fs, path, readAll(), writeAll(), addTask(), buildDatetime(), fs (+6 more)

### Community 44 - "progress.js"
Cohesion: 0.22
Nodes (16): checkAndSendDailyVerse(), execProgress(), execVerse(), sendVerseImage(), generateVerseImageBuffer(), applyForceOverride(), ensureProgressSeeded(), fs (+8 more)

### Community 45 - "xlsxFill.js"
Cohesion: 0.28
Nodes (16): cellStyle(), crc32(), decodeXml(), entryText(), escXml(), fillTemplate(), find(), locateSheet() (+8 more)

### Community 46 - "generate_verse_image.py"
Cohesion: 0.18
Nodes (4): _draw_tracked(), generate_verse_image(), _layout_content(), _wrap()

### Community 47 - "programsWatch.js"
Cohesion: 0.23
Nodes (15): checkAndRunProgramsWatch(), runProgramsWatchCheck(), buildProgramUpdateMessage(), checkForNewPrograms(), fetchProgramRows(), findColumns(), fs, getProgramsWatchLastRunDate() (+7 more)

### Community 48 - "ozonMsg.js"
Cohesion: 0.22
Nodes (15): addDays(), codeBlocks(), dm(), esc(), installMarker(), isOzonText(), mark(), periodLine() (+7 more)

### Community 49 - "accrualsReport.js"
Cohesion: 0.23
Nodes (14): buildMessage(), clean(), fs, isRoutine(), lastReportTo(), money(), num(), parse() (+6 more)

### Community 50 - "ozonPost"
Cohesion: 0.35
Nodes (11): extractList(), fetchCatalog(), fetchPrices(), fetchStockRows(), fetchViaAnalytics(), normalizeRow(), num(), ozonPost() (+3 more)

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
Cohesion: 0.28
Nodes (8): approvalMessages(), supportText(), assert, os, path, test, topicOf(), warehouseMessage()

### Community 55 - "checkDisputesPeriodic"
Cohesion: 0.36
Nodes (8): applyFixes(), getState(), markSent(), patchState(), pickNew(), readJson(), writeJsonAtomic(), checkDisputesPeriodic()

### Community 56 - "ozonMsg.test.js"
Cohesion: 0.25
Nodes (6): assert, dir, fs, os, path, test

### Community 57 - "ozonStock.js"
Cohesion: 0.46
Nodes (6): hasWriteKey(), OzonWriteError, post(), WAREHOUSE_ID(), WRITE_ENDPOINT(), writeStocks()

### Community 58 - "returnsWatch.test.js"
Cohesion: 0.29
Nodes (5): ago(), assert, mk(), NOW, test

### Community 59 - "translate/store.js"
Cohesion: 0.43
Nodes (7): disable(), enable(), fs, isEnabled(), path, readAll(), writeAll()

### Community 60 - "@anthropic-ai/sdk"
Cohesion: 0.33
Nodes (6): analyzePhoto(), Anthropic, guessMediaType(), KNOWN_AXES, @anthropic-ai/sdk@^0.116.0, @anthropic-ai/sdk

### Community 61 - "collectDisputeReport"
Cohesion: 0.40
Nodes (6): candidatesFromReturns(), fetchWriteoffsApi(), msToIso(), ret(), collectDisputeReport(), isConfigured()

### Community 62 - "formatShort"
Cohesion: 0.33
Nodes (6): formatShort(), ruDM(), shortRef(), splitMessage(), sendShortReport(), splitMessage()

### Community 63 - "events/extract.js"
Cohesion: 0.53
Nodes (3): FORMATS, PROGRAMS, Anthropic

### Community 64 - "events/format.js"
Cohesion: 0.40
Nodes (5): buildConfirmationText(), FORMAT_LABELS_RU, formatDateRu(), MONTHS_RU, WEEKDAYS_RU

### Community 65 - "watch.js"
Cohesion: 0.53
Nodes (5): getWatchedGroupIds(), hasCourseMention(), hasDateMention(), hasTimeMention(), looksLikeAnnouncement()

### Community 66 - "fotoVision.js"
Cohesion: 0.47
Nodes (5): Anthropic, call(), costOf(), PRICE, readLabel()

### Community 67 - "trivial.js"
Cohesion: 0.50
Nodes (4): isTrivialMessage(), normalize(), TRIVIAL_PHRASES, TRIVIAL_SET

### Community 68 - "gabarity/format.js"
Cohesion: 0.83
Nodes (3): buildResultText(), cmToMm(), kgToG()

## Knowledge Gaps
- **1 isolated node(s):** `RFC-4180`
  These have ≤1 connection - possible missing edges or undocumented components. (Counts symbols only; 393 node(s) total have ≤1 connection when file, concept and rationale nodes are included.)
- **4 thin communities (<3 nodes) omitted from report** — run `graphify query` to explore isolated nodes.

## Suggested Questions
_Questions this graph is uniquely positioned to answer:_

- **Why does `Ozon: ежедневная форма (цвет, садовые бирки) — `ozon-form/index.js`` connect `cardButtons.js` to `baliDateString`, `training.js`, `ref_fs`, `assistantsSeries.js`, `ozonMsg.js`, `accrualsReport.js`, `controlPoints.js`, `helperRoles.js`, `programNeeds.js`, `programRules.js`?**
  _High betweenness centrality (0.017) - this node is a cross-community bridge._
- **Are the 3 inferred relationships involving `escapeHtml()` (e.g. with `report.js` and `partialDataWarningEn()`) actually correct?**
  _`escapeHtml()` has 3 INFERRED edges - model-reasoned connections that need verification._
- **What connects `RFC-4180` to the rest of the system?**
  _1 weakly-connected nodes found - possible documentation gaps or missing edges._
- **Should `cardButtons.js` be split into smaller, more focused modules?**
  _Cohesion score 0.05271529197909566 - nodes in this community are weakly interconnected._
- **Why does `Maitreya — бот-помощник Elena` connect `baliDateString` to `cardButtons.js`, `supplier.js`?**
  _High betweenness centrality (0.012) - this node is a cross-community bridge._
- **Are the 3 inferred relationships involving `baliDateString()` (e.g. with `Ключевые архитектурные решения (сквозные, применены во всех модулях)` and `На что обратить внимание при доработках`) actually correct?**
  _`baliDateString()` has 3 INFERRED edges - model-reasoned connections that need verification._
- **Should `index.js` be split into smaller, more focused modules?**
  _Cohesion score 0.030864197530864196 - nodes in this community are weakly interconnected._