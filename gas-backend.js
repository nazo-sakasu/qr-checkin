// ============================================================
// QR受付システム v3 - Google Apps Script バックエンド
// 改善点:
//   ① ID→行番号をMapで管理（全行走査を廃止）
//   ② LockServiceで同時アクセス排他制御（二重受付防止）
//   ③ 差分取得API追加（ダッシュボード負荷軽減）
// ============================================================

const SHEET_NAME = "participants";
const LOCK_TIMEOUT_MS = 10000; // ロック取得タイムアウト10秒

// ─── ルーティング ────────────────────────────────
function doGet(e)  { return handleRequest(e); }
function doPost(e) { return handleRequest(e); }

function handleRequest(e) {
  const p = e.parameter;
  let result;
  try {
    switch (p.action) {
      case "getAll":    result = getAllParticipants(); break;
      case "getStats":  result = getStats(); break;          // ③ 軽量統計API
      case "getDiff":   result = getDiff(p.since); break;    // ③ 差分API
      case "checkin":   result = checkinParticipant(p.id, p.adults, p.children); break;
      case "importCSV": result = importParticipants(p.data); break;
      case "reset":     result = resetCheckin(p.id); break;
      default:          result = { success: false, error: "Unknown action" };
    }
  } catch (err) {
    result = { success: false, error: err.message };
  }
  return ContentService
    .createTextOutput(JSON.stringify(result))
    .setMimeType(ContentService.MimeType.JSON);
}

// ─── シート取得 ──────────────────────────────────
function getSheet() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sheet = ss.getSheetByName(SHEET_NAME);
  if (!sheet) {
    sheet = ss.insertSheet(SHEET_NAME);
    sheet.getRange(1,1,1,9).setValues([[
      "ID","氏名","フリガナ","大人（予定）","小人（予定）",
      "受付日時","大人（実績）","小人（実績）","更新タイムスタンプ"
    ]]);
    sheet.getRange(1,1,1,9).setFontWeight("bold");
  }
  return sheet;
}

// ① IDからMap生成（全行走査を1回だけに限定）
function buildIdMap(data) {
  const map = {};
  for (let i = 1; i < data.length; i++) {
    map[String(data[i][0])] = i; // id → 行インデックス(0始まり, ヘッダー除く)
  }
  return map;
}

function rowToParticipant(row) {
  return {
    id:             String(row[0]),
    name:           row[1],
    kana:           row[2],
    adults:         Number(row[3]) || 0,
    children:       Number(row[4]) || 0,
    checkedInAt:    row[5] || null,
    actualAdults:   row[6] !== "" ? Number(row[6]) : null,
    actualChildren: row[7] !== "" ? Number(row[7]) : null,
    updatedAt:      row[8] || null,
  };
}

// ─── 全件取得（初回ロード用）────────────────────
function getAllParticipants() {
  const sheet = getSheet();
  const data  = sheet.getDataRange().getValues();
  if (data.length <= 1) return { success: true, participants: [], serverTime: Date.now() };
  return {
    success:      true,
    participants: data.slice(1).map(rowToParticipant),
    serverTime:   Date.now(),
  };
}

// ③ 軽量統計API（ダッシュボード用 - 全データを返さない）
function getStats() {
  const sheet = getSheet();
  const data  = sheet.getDataRange().getValues();
  if (data.length <= 1) {
    return { success: true, total: 0, checked: 0, actualAdults: 0, actualChildren: 0, serverTime: Date.now() };
  }
  let total = 0, checked = 0, actualAdults = 0, actualChildren = 0;
  for (let i = 1; i < data.length; i++) {
    total++;
    if (data[i][5]) {
      checked++;
      actualAdults   += Number(data[i][6]) || 0;
      actualChildren += Number(data[i][7]) || 0;
    }
  }
  return { success: true, total, checked, actualAdults, actualChildren, serverTime: Date.now() };
}

// ③ 差分API（since以降に更新された行のみ返す）
function getDiff(since) {
  if (!since) return getAllParticipants();
  const sinceTs = Number(since);
  const sheet   = getSheet();
  const data    = sheet.getDataRange().getValues();
  const updated = [];
  for (let i = 1; i < data.length; i++) {
    const ts = Number(data[i][8]) || 0;
    if (ts > sinceTs) updated.push(rowToParticipant(data[i]));
  }
  return { success: true, diff: updated, serverTime: Date.now() };
}

// ─── 受付処理（② LockService + ① Map検索）────────
function checkinParticipant(id, adults, children) {
  // ② スクリプトロックで排他制御（同時アクセスをシリアライズ）
  const lock = LockService.getScriptLock();
  try {
    lock.waitLock(LOCK_TIMEOUT_MS);
  } catch(e) {
    return { success: false, error: "サーバーが混雑しています。もう一度スキャンしてください。" };
  }

  try {
    const sheet = getSheet();
    const data  = sheet.getDataRange().getValues();

    // ① Mapで瞬時に行特定
    const idMap  = buildIdMap(data);
    const rowIdx = idMap[String(id)];

    if (rowIdx === undefined) {
      return { success: false, notFound: true };
    }

    const row = data[rowIdx];

    // すでに受付済みチェック
    if (row[5]) {
      return {
        success: false,
        alreadyCheckedIn: true,
        participant: rowToParticipant(row),
      };
    }

    // 受付処理
    const now       = Utilities.formatDate(new Date(), "Asia/Tokyo", "yyyy/MM/dd HH:mm:ss");
    const nowTs     = String(Date.now());
    const actualA   = (adults   !== undefined && adults   !== "") ? Number(adults)   : Number(row[3]);
    const actualC   = (children !== undefined && children !== "") ? Number(children) : Number(row[4]);
    const sheetRow  = rowIdx + 2; // シートの実際の行番号（ヘッダー1行 + 0始まり補正）

    sheet.getRange(sheetRow, 6, 1, 4).setValues([[now, actualA, actualC, nowTs]]);

    return {
      success: true,
      participant: {
        ...rowToParticipant(row),
        checkedInAt:    now,
        actualAdults:   actualA,
        actualChildren: actualC,
        updatedAt:      nowTs,
      },
    };
  } finally {
    // ② 必ずロック解放
    lock.releaseLock();
  }
}

// ─── データ取込 ──────────────────────────────────
function importParticipants(csvData) {
  const sheet   = getSheet();
  const lastRow = sheet.getLastRow();
  if (lastRow > 1) sheet.deleteRows(2, lastRow - 1);

  const rows = JSON.parse(csvData);
  if (rows.length === 0) return { success: true, count: 0 };

  const values = rows.map(r => [
    r.id, r.name, r.kana || "",
    Number(r.adults) || 0, Number(r.children) || 0,
    "", "", "", "", // 受付日時・実績大人・実績小人・タイムスタンプ
  ]);
  sheet.getRange(2, 1, values.length, 9).setValues(values);
  return { success: true, count: rows.length };
}

// ─── 受付リセット ────────────────────────────────
function resetCheckin(id) {
  const lock = LockService.getScriptLock();
  try { lock.waitLock(LOCK_TIMEOUT_MS); } catch(e) { return { success: false, error: "混雑中" }; }
  try {
    const sheet  = getSheet();
    const data   = sheet.getDataRange().getValues();
    const idMap  = buildIdMap(data);
    const rowIdx = idMap[String(id)];
    if (rowIdx === undefined) return { success: false, notFound: true };
    sheet.getRange(rowIdx + 2, 6, 1, 4).setValues([["", "", "", ""]]);
    return { success: true };
  } finally {
    lock.releaseLock();
  }
}
