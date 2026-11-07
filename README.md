# 供應鏈技術知識體系 MVP

按《供應鏈技術知識體系 MVP 建模設計 v0.1》實作的私有領域知識庫：智能體能可靠引用，人機能共同維護，知識能自動保鮮。

| 交付項 | 實作 |
| --- | --- |
| 知識持久化 | 使用你指定的 **Git 倉庫**：知識以 YAML 檔案存放，每次寫入是一次提交，作者記為提交知識的人、智能體或管道；定期拉取他人直接在 Git 中做的修改 |
| 管理後台 | `/`：知識管理與可視化（主體、斷言、客體、關係、知識圖譜、層級分佈、重驗隊列、衝突、反饋、缺口、動力層、API 金鑰、設定），視覺沿用 `agent_subscribe_plan` 的 Portal 樣式包 |
| 生產型 API | `/api/v1`：三方智能體提交與管理主體、客體、綁定、斷言、關係，支持批量提交、補證據、校驗、衝突、反饋 |
| 教程 prompt API | `GET /api/v1/prompt`（公開）：三方智能體拉取後即可學會如何生產知識；`?role=consumer` 為消費教程 |
| 消費型 API | `POST /api/v1/ask` 返回結構化知識卡 + 自然語言答案（經 **OpenRouter** 組織，未配置時用規則模板）；另有知識卡、圖譜、術語解析、取值 Action 等 |

## 快速開始

需要 Node.js 20+ 與 git。

```bash
npm install
ADMIN_PASSWORD='請換成你的密碼' npm start
# 打開 http://localhost:8080 ，用上面的密碼登入
```

1. 登入後到 **設定 › 知識倉庫** 填入你的 Git 倉庫地址與存取權杖（GitHub 細粒度 PAT，需 Contents 讀寫），點「測試連接」後「保存並切換」。不填則使用本地倉庫。
2. 同一頁可點 **載入示例資料**：設計文件中的「可售庫存」示例與庫存域試點主體（系統名、表名、接口名均為示意）。
3. 到 **設定 › 自然語言** 填入 OpenRouter API Key 與模型 ID。
4. 到 **接入 › API 金鑰** 為三方智能體發放金鑰，把 `http://<你的地址>/api/v1/prompt` 交給它。
5. 到 **接入 › 問答測試** 試問設計文件中的 6 個問題。

也可以全部用環境變數配置，見 [.env.example](.env.example)。容器部署：`docker build -t knowledge . && docker run -p 8080:8080 -v knowledge-data:/data -e ADMIN_PASSWORD=... knowledge`。

## 知識倉庫結構

```
knowledge/
  config.yaml              領域代碼、有效期初值等規則參數
  subjects/S-INV-0012.yaml 主體；其下掛客體綁定 bindings 與斷言 assertions
  objects/O-0001.yaml      客體（數字 / 制度 / 物理）
  relations/R-0001.yaml    主體之間的關係（10 種閉集），帶有效性
  actions/ACT-0001.yaml    Action（校驗 / 取值，只讀）
  pipelines/P-0001.yaml    管道（憑證以 ${env:變數} 引用，不入庫）
  governance/              衝突 C-、反饋 F-、知識缺口 G-
  stats/usage.yaml         主體被使用次數（重驗優先級、L0 覆蓋率）
```

機密（Git 權杖、OpenRouter Key、管理員密碼雜湊、API 金鑰雜湊）只存在服務本地的 `DATA_DIR/settings.json`，不進入知識倉庫。

## 設計文件到實作的對應

| 設計要求 | 實作位置 |
| --- | --- |
| 6 個概念、6 種主體類型、10 種關係類型（含方向）、2 種 Action、L0/L1/L2/E1 | `src/store/model.js` |
| 有效性字段附在綁定、斷言、關係三處 | `src/store/validity.js` |
| 主體綜合層級 = 有效綁定中的最高層級，無有效綁定為 L2（只讀，不入庫） | `KnowledgeStore.subjectLevel` |
| 寫入上限：人或智能體附證據最高 L1、無證據 L2、不能寫 L0；管道按校驗結果定級 | `capSubmittedLevel` |
| 上行只有 L2→L1（補證據）與 L1→L0（Action 校驗或負責人確認）；智能體不能晉升 | `addEvidence`、`confirm`、`assertOwner` |
| 到期、校驗不符、衝突、反饋錯誤先降回 L1 並排入重驗；E1 不刪除、指向替代者 | `demoteToL1`、`invalidate` |
| 客體下線：綁定轉 E1，以它為證據的斷言和關係降為 L1 | `takeObjectOffline` |
| 衝突不設獨立狀態：雙方降 L1，裁決後一方 L0、另一方 E1 | `reportConflict`、`resolveConflict` |
| 每個業務對象或指標只有一條 L0「擁有」關係 | `assertSingleOwner` |
| 別名三條規則（只經別名關係、可一詞多義、檢索先解析） | `createSubject`、`resolveTerms` |
| 有效期初值 30 / 90 / 180 天，負責人可按主體調整 | `config.yaml`、主體 `expiryDays` |
| 動態值不存儲，經取值 Action 實時獲取；MVP 只讀 | `src/services/actions.js` |
| 智能體使用規約 6 步（解析、動態值、按層級、引用、未收錄、反饋） | `src/services/ask.js` |
| 三類保鮮觸發（時間、客體變更、使用反饋）；重驗按「使用頻率 × 出錯代價」排序 | 排程任務、`revalidationQueue` |
| 健康指標：L0 覆蓋率、待重驗數、未收錄查詢數、L0 錯誤反饋數 | `KnowledgeStore.health`、後台「健康指標」 |

## API 概覽

認證：`Authorization: Bearer <API 金鑰>`。角色：`consumer`（讀與問答）、`contributor`（另可提交知識）、`owner`（只能是人；確認晉升、裁決、判定失效、配置動力層）。管道金鑰提交的知識按管道校驗結果直接定級。回應格式 `{ data, commit?, warnings? }`，錯誤 `{ error: { code, message } }`。完整列表見後台「接入 › API 參考」或 `GET /api/v1/openapi.json`。

```bash
# 三方智能體拉取教程（公開）
curl -s http://localhost:8080/api/v1/prompt

# 消費：問答
curl -s -X POST http://localhost:8080/api/v1/ask \
  -H "Authorization: Bearer $KEY" -H "Content-Type: application/json" \
  -d '{"question":"SKU-123 在上海一號倉還有多少可售？"}'
```

`/ask` 的 `status`：`answered`、`ambiguous`（別名多義，帶 `subjectIds` 重問）、`need_inputs`（動態值缺參數）、`uncovered`（未收錄，已記為知識缺口）。每條引用都帶層級；OpenRouter 返回的引用會與知識範圍比對，範圍外的 ID 被丟棄。

## 開發

```bash
npm run dev     # 監聽修改自動重啟
npm test        # 23 項：模型規則 + 端到端（含 OpenRouter 模擬、Git 遠端推送與回拉）
npm run seed    # 命令列載入示例資料
```

技術選型：Node.js + Express 5 + `yaml`，後台為無建置步驟的原生 JS（ES modules），圖譜為自寫的力導向 SVG，無 CDN 依賴。

## MVP 不做（與設計文件一致）

寫型 Action、自動推理生成新知識、多來源衝突的自動裁決、細粒度權限。設計文件中的待決問題（試點子域、負責人名單、存儲選型、有效期細分、引用格式）在本實作中的處理：試點按庫存域示例；負責人為主體上的文本字段，可選綁定負責人金鑰；存儲採用 Git + 記憶體索引（50–150 個主體的規模足夠）；有效期按條目類型細分並可按主體覆蓋；引用格式為 `〔ID·層級〕`，未收錄問題記入 `governance/gaps/`。
