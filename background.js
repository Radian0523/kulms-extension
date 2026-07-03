// KULMS Background Service Worker

// インストール/更新時にキャッシュをクリア & TOTP 平文マイグレーション
chrome.runtime.onInstalled.addListener(async () => {
  chrome.storage.local.remove(["kulms-syllabus-catalog", "kulms-textbooks"]);

  // eviction 保護を要求
  ensureTotpPersistence();

  // 旧キー kulms-totp-secret（平文）が残っていれば暗号化して移行
  try {
    const result = await chrome.storage.local.get(["kulms-totp-secret"]);
    const plainSecret = result["kulms-totp-secret"];
    if (plainSecret) {
      await saveTotpSecret(plainSecret);
      await chrome.storage.local.remove(["kulms-totp-secret"]);
      console.log("[KULMS] migrated TOTP secret from plaintext to encrypted");
    }
  } catch (e) {
    console.warn("[KULMS] TOTP migration error:", e.message);
  }
});

// 起動時にも eviction 保護を再要求する
chrome.runtime.onStartup.addListener(() => {
  ensureTotpPersistence();
});

// === シラバス教科書取得ハンドラ ===

const SYLLABUS_BASE = "https://www.k.kyoto-u.ac.jp/external/open_syllabus";
const LMS_BASE = "https://lms.gakusei.kyoto-u.ac.jp";

// 科目名からコース番号部分や年度/曜日限情報を除去して検索用キーワードにする
function cleanCourseName(name) {
  // [2026前期水２]固体電子工学 → 固体電子工学
  return name
    .replace(/^\s*\[[^\]]*\]\s*/, "")
    .replace(/\s*\(.*\)\s*$/, "")
    .trim();
}

// 全角→半角正規化（マッチング用）
function normalizeForMatch(str) {
  return str
    .replace(/[\uFF01-\uFF5E]/g, (ch) =>
      String.fromCharCode(ch.charCodeAt(0) - 0xfee0)
    )
    .replace(/\u3000/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

// 教員名比較用の正規化（空白/全角空白/NBSP をすべて除去）
// KULASIS は "京大 太郎"、Sakai は "京大太郎" と表記揺れがあるため
function normalizeTeacherName(str) {
  return String(str || "")
    .replace(/[\s\u3000\u00A0]+/g, "")
    .trim();
}

// Sakai サイト情報ツールから「サイト連絡先・メール」欄の教員名を抽出
// 失敗時は null を返す（呼び出し元はフォールバック判断）
async function fetchSakaiSiteContact(siteId) {
  if (!siteId) return null;
  try {
    // Step 1: pages.json から sakai.siteinfo の placementId を取得
    const pagesRes = await fetch(
      `${LMS_BASE}/direct/site/${encodeURIComponent(siteId)}/pages.json`,
      { credentials: "include" }
    );
    if (!pagesRes.ok) return null;
    const pages = await pagesRes.json();
    let placementId = null;
    for (const p of pages || []) {
      for (const t of p.tools || []) {
        if (t.toolId === "sakai.siteinfo") {
          placementId = t.placementId;
          break;
        }
      }
      if (placementId) break;
    }
    if (!placementId) return null;

    // Step 2: Site Info HTML を取得して「サイト連絡先・メール」行を抽出
    const htmlRes = await fetch(
      `${LMS_BASE}/portal/tool/${encodeURIComponent(placementId)}`,
      { credentials: "include" }
    );
    if (!htmlRes.ok) return null;
    const html = await htmlRes.text();

    // <th>サイト連絡先・メール</th> ... <td> 教員名, <a href="mailto:..."> ...
    // 教員名はカンマ or '<' の手前まで
    const m = html.match(
      /サイト連絡先[・･\u30FB]?メール[\s\S]*?<td[^>]*>\s*([^,<\n]+?)\s*(?:,|<)/
    );
    if (!m) return null;
    const name = m[1].trim();
    if (!name || /<|>/.test(name)) return null;
    return name;
  } catch (e) {
    console.warn("[KULMS] fetchSakaiSiteContact error:", e.message);
    return null;
  }
}

// Shift_JISエンコード用テーブル（Unicode文字 → Shift_JISバイト列）
let sjisEncodeTable = null;

function buildSjisEncodeTable() {
  const map = new Map();
  const decoder = new TextDecoder("shift_jis", { fatal: true });

  // Double-byte characters
  for (let hi = 0x81; hi <= 0xfc; hi++) {
    if (hi >= 0xa0 && hi <= 0xdf) continue;
    for (let lo = 0x40; lo <= 0xfc; lo++) {
      if (lo === 0x7f) continue;
      try {
        const bytes = new Uint8Array([hi, lo]);
        const char = decoder.decode(bytes);
        if (char.length === 1 && !map.has(char)) {
          map.set(char, [hi, lo]);
        }
      } catch (e) {
        // invalid sequence
      }
    }
  }

  // Halfwidth katakana (0xA1-0xDF)
  for (let b = 0xa1; b <= 0xdf; b++) {
    try {
      const bytes = new Uint8Array([b]);
      const char = decoder.decode(bytes);
      if (char.length === 1 && !map.has(char)) {
        map.set(char, [b]);
      }
    } catch (e) {}
  }

  return map;
}

// 文字列をShift_JISでパーセントエンコードする（URLクエリパラメータ用）
function encodeShiftJIS(str) {
  if (!sjisEncodeTable) sjisEncodeTable = buildSjisEncodeTable();

  let encoded = "";
  for (const char of str) {
    const code = char.charCodeAt(0);
    // ASCII unreserved characters: そのまま
    if (
      (code >= 0x30 && code <= 0x39) || // 0-9
      (code >= 0x41 && code <= 0x5a) || // A-Z
      (code >= 0x61 && code <= 0x7a) || // a-z
      code === 0x2d || code === 0x2e || code === 0x5f || code === 0x7e
    ) {
      encoded += char;
      continue;
    }
    // Space → +
    if (code === 0x20) {
      encoded += "+";
      continue;
    }
    // Shift_JIS lookup
    const bytes = sjisEncodeTable.get(char);
    if (bytes) {
      for (const b of bytes) {
        encoded += "%" + b.toString(16).toUpperCase().padStart(2, "0");
      }
    } else {
      // Fallback: percent-encode the ASCII byte
      if (code < 0x80) {
        encoded += "%" + code.toString(16).toUpperCase().padStart(2, "0");
      }
    }
  }
  return encoded;
}

// HTMLをWindows-31J等でデコードするヘルパー
async function fetchAndDecode(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error("Fetch failed: " + res.status);
  const buf = await res.arrayBuffer();
  const ct = res.headers.get("content-type") || "";
  const charsetMatch = ct.match(/charset=([^\s;]+)/i);
  let encoding = charsetMatch ? charsetMatch[1] : "shift_jis";
  try {
    return new TextDecoder(encoding).decode(buf);
  } catch (e) {
    return new TextDecoder("utf-8").decode(buf);
  }
}

// /search エンドポイントで科目名を検索し、最適な lectureNo を返す
// 全学部・全科目 (11,848件) が対象
//
// options:
//   - expectedName: 検索結果の中で名前マッチさせたい科目名 (lectureCode検索時に指定)
//     指定時はマッチしなければ null を返す（呼び出し元でフォールバック判断）
//   - expectedTeacher: 名前マッチ候補が複数残った場合の絞り込みに使う教員名
//     文字列または async 関数 (遅延フェッチ用) を指定可
async function searchSyllabus(keyword, options) {
  options = options || {};
  // サーバーがShift_JISエンコードを期待するため、encodeShiftJISを使用
  // x/y パラメータは <input type="image"> のsubmitボタン座標（必須）
  const searchUrl =
    SYLLABUS_BASE +
    "/search?condition.keyword=" +
    encodeShiftJIS(keyword) +
    "&condition.departmentNo=&condition.openSyllabusTitle=" +
    "&condition.courseNumberingJugyokeitaiNo=&condition.courseNumberingLanguageNo=" +
    "&condition.semesterNo=&condition.courseNumberingLevelNo=" +
    "&condition.courseNumberingBunkaNo=&condition.teacherName=" +
    "&x=0&y=0";

  console.log("[KULMS] searching syllabus for:", keyword);
  const html = await fetchAndDecode(searchUrl);

  // テーブル行単位で lectureNo, departmentNo, 科目名を抽出
  // 検索結果の構造:
  //   <tr><td>科目名</td><td>教員</td>...<td><a href="department_syllabus?lectureNo=XXX&departmentNo=YY"><img/></a></td></tr>
  const rowRe = /<tr[^>]*>([\s\S]*?)<\/tr>/gi;
  const results = [];
  const seen = new Set();
  let rm;
  while ((rm = rowRe.exec(html)) !== null) {
    const rowHtml = rm[1];
    const lectureMatch = rowHtml.match(
      /(?:department_syllabus|la_syllabus)\?lectureNo=(\d+)(?:&(?:amp;)?departmentNo=(\d+))?/
    );
    if (!lectureMatch) continue;
    const lectureNo = lectureMatch[1];
    const departmentNo = lectureMatch[2] || "";
    if (seen.has(lectureNo)) continue;
    seen.add(lectureNo);

    // <td> セルのテキスト内容を抽出（imgタグ等を除去）
    const tdRe = /<td[^>]*>([\s\S]*?)<\/td>/gi;
    const cells = [];
    let td;
    while ((td = tdRe.exec(rowHtml)) !== null) {
      const text = td[1].replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim();
      if (text && text.length > 1) cells.push(text);
    }

    // 最初の非空セルが科目名、2 番目が教員名（複数教員はスペース区切りで連結される）
    const name = cells[0] || "";
    const teacherName = cells[1] || "";
    if (name) {
      results.push({ lectureNo, departmentNo, name, teacherName });
    }
  }

  console.log("[KULMS] search results:", results.length, "entries");
  if (results.length === 0) return null;
  if (results.length <= 5) {
    console.log(
      "[KULMS] results:",
      results.map((r) => r.name).join(", ")
    );
  }

  // expectedName が指定されていれば、その科目名で結果から絞り込む
  // (lectureCode 検索など、keyword 自体が科目名でないケース用)
  const matchTarget = options.expectedName || keyword;
  const normalized = normalizeForMatch(matchTarget);

  function pickResult(r, label) {
    console.log("[KULMS]", label + ":", r.name, "/", r.teacherName, r.lectureNo);
    return { lectureNo: r.lectureNo, departmentNo: r.departmentNo };
  }

  // 完全一致（正規化後）
  const exactMatches = results.filter(
    (r) => normalizeForMatch(r.name) === normalized
  );
  if (exactMatches.length === 1) {
    return pickResult(exactMatches[0], "exact match");
  }
  if (exactMatches.length > 1) {
    const winner = await disambiguateByTeacher(exactMatches, options);
    if (winner) return pickResult(winner, "exact match (teacher-disambiguated)");
    return pickResult(exactMatches[0], "exact match (first of " + exactMatches.length + ", teacher unknown)");
  }

  // 部分一致
  const partialMatches = results.filter((r) => {
    const rn = normalizeForMatch(r.name);
    return rn.includes(normalized) || normalized.includes(rn);
  });
  if (partialMatches.length === 1) {
    return pickResult(partialMatches[0], "partial match");
  }
  if (partialMatches.length > 1) {
    const winner = await disambiguateByTeacher(partialMatches, options);
    if (winner) return pickResult(winner, "partial match (teacher-disambiguated)");
    return pickResult(partialMatches[0], "partial match (first of " + partialMatches.length + ", teacher unknown)");
  }

  // expectedName 指定時は名前マッチが見つからなければフォールバック判断を呼び出し元に任せる
  // (lectureCode 検索で全く別科目を選んでしまうのを防ぐ)
  if (options.expectedName) {
    console.log(
      "[KULMS] no name match for expectedName:",
      options.expectedName,
      "(keyword:",
      keyword + ")"
    );
    return null;
  }

  // 検索エンジンが返した最初の結果を使用 (科目名検索の最終フォールバック)
  console.log(
    "[KULMS] using first result:",
    results[0].name,
    results[0].lectureNo
  );
  return { lectureNo: results[0].lectureNo, departmentNo: results[0].departmentNo };
}

// 名前マッチが複数残った場合、教員名で絞り込む
// options.expectedTeacher は文字列または async 関数 (遅延 fetch 用)
async function disambiguateByTeacher(candidates, options) {
  if (!options.expectedTeacher) return null;
  let teacher = options.expectedTeacher;
  if (typeof teacher === "function") {
    try {
      teacher = await teacher();
    } catch (e) {
      console.warn("[KULMS] expectedTeacher fetch failed:", e.message);
      teacher = null;
    }
  }
  if (!teacher) return null;
  const teacherKey = normalizeTeacherName(teacher);
  if (!teacherKey) return null;
  console.log("[KULMS] disambiguating by teacher:", teacher);
  const found = candidates.find((c) => {
    const ck = normalizeTeacherName(c.teacherName || "");
    return ck && (ck.includes(teacherKey) || teacherKey.includes(ck));
  });
  return found || null;
}

// シラバス詳細ページから教科書・参考書情報を抽出
async function fetchSyllabusDetail(lectureNo, departmentNo) {
  const url = departmentNo
    ? `${SYLLABUS_BASE}/department_syllabus?lectureNo=${lectureNo}&departmentNo=${departmentNo}`
    : `${SYLLABUS_BASE}/la_syllabus?lectureNo=${lectureNo}`;
  const html = await fetchAndDecode(url);
  const books = [];

  // DOMParserはService Workerで使えないので正規表現でパース
  // 実際のページでは「教科書」「参考書」がセクション見出しとして出現し、
  // その後に書名・著者・ISBN等が続く構造
  // 複数のパターンで走査する

  // HTMLタグを除去してプレーンテキスト化（セクション区切りを保持）
  const text = html
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, "")
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(?:div|p|tr|td|th|li|h[1-6])>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&#\d+;/g, "")
    .replace(/[ \t]+/g, " ");

  // セクション見出しで教科書/参考書を判定し、エントリを解析
  // シラバスHTML構造:
  //   <span class="lesson_plan_subheading">(教科書)</span>
  //   金東海『現代電気機器理論』(電気学会) ISBN:9784886862808 <br/>
  // エントリ形式: 著者名『書名』(出版社) ISBN:xxx
  const sectionHeadings =
    /(?:教科書|参考書|テキスト|参考文献|予習|復習|成績|授業外|履修|その他|備考|関連URL|オフィスアワー)/;
  const textbookHeadings = /(?:教科書|テキスト)/;
  const referenceHeadings = /(?:参考書|参考文献)/;
  const targetHeadings = /(?:教科書|参考書|テキスト|参考文献)/;

  const lines = text.split("\n").map((l) => l.trim());
  let currentType = null; // "textbook" | "reference" | null

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // セクション見出し判定
    if (line.length < 30 && targetHeadings.test(line)) {
      if (textbookHeadings.test(line)) {
        currentType = "textbook";
      } else if (referenceHeadings.test(line)) {
        currentType = "reference";
      }
      continue;
    }
    if (
      currentType &&
      line.length < 30 &&
      sectionHeadings.test(line) &&
      !targetHeadings.test(line)
    ) {
      currentType = null;
      continue;
    }

    if (!currentType) continue;
    if (line.length < 4) continue;
    if (/^(?:特になし|なし|使用しない|No textbook|None)/i.test(line)) {
      currentType = null;
      continue;
    }

    let author = "";
    let title = "";
    let publisher = "";
    let isbn = "";

    // ISBN抽出: ISBN:xxx or isbn{}{xxx}
    const isbnMatch = line.match(/ISBN[:\s{}-]*([\d][\d-]{7,16}[\d])/i);
    if (isbnMatch) {
      isbn = isbnMatch[1].replace(/-/g, "");
    }

    // 『書名』パターン: 著者『書名』(出版社)
    const bracketMatch = line.match(/^(.*?)\u300E(.+?)\u300F/);
    if (bracketMatch) {
      author = bracketMatch[1]
        .replace(/[,、]\s*$/, "")
        .trim();
      title = bracketMatch[2].trim();

      // 出版社: (xxx) or （xxx）
      const pubMatch = line.match(/[\uFF08(]([^\uFF09)]+)[\uFF09)]/);
      if (pubMatch) {
        publisher = pubMatch[1]
          .replace(/[、,]\s*\d{4}\u5E74?/, "") // 年を除去
          .trim();
      }
    } else {
      // 『』がない場合はフォールバック: 行全体から情報を抽出
      title = line
        .replace(/ISBN[:\s{}-]*[\d-]+/gi, "")
        .replace(/\d{4}\u5E74?$/g, "")
        .replace(/[\s,\u3001;\uFF1B]+$/g, "")
        .trim();

      const pubFallback = line.match(
        /[,\u3001]\s*([^,\u3001]+?(?:\u793E|\u51FA\u7248|\u66F8[\u5E97\u9662\u623F]|\u30D7\u30EC\u30B9|Press|Publishing|University Press))/i
      );
      if (pubFallback) {
        publisher = pubFallback[1].trim();
        title = title.replace(publisher, "").replace(/[,\u3001]\s*$/, "").trim();
      }
    }

    if (title && title.length > 2) {
      books.push({ title, author, publisher, isbn, type: currentType });
    }
  }

  // 重複を除去
  const seen = new Set();
  return books.filter((b) => {
    const key = b.type + ":" + b.title.substring(0, 20);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

// メッセージハンドラ
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.action !== "fetchTextbooks") return false;

  const courseName = message.courseName;
  const siteId = String(message.siteId || "").trim();
  const lectureCode = String(message.lectureCode || "").trim().toUpperCase();
  if (!courseName && !lectureCode) {
    sendResponse({ books: [] });
    return false;
  }

  const keyword = cleanCourseName(courseName || "");
  if (!lectureCode && !keyword) {
    sendResponse({ books: [] });
    return false;
  }

  // 教員名は遅延フェッチ (一度だけ実行されるようメモ化)
  let teacherPromise = null;
  const lazyTeacher = () => {
    if (!siteId) return Promise.resolve(null);
    if (!teacherPromise) teacherPromise = fetchSakaiSiteContact(siteId);
    return teacherPromise;
  };

  (async () => {
    try {
      if (lectureCode && keyword) {
        // lectureCode で検索 + 科目名で絞り込み（同名科目問題と誤マッチの両方を防ぐ）
        // 名前で複数候補が残った場合は Sakai の連絡先教員名で絞り込む
        const matched = await searchSyllabus(lectureCode, {
          expectedName: keyword,
          expectedTeacher: lazyTeacher,
        });
        if (matched) {
          const syllabusUrl = matched.departmentNo
            ? `${SYLLABUS_BASE}/department_syllabus?lectureNo=${matched.lectureNo}&departmentNo=${matched.departmentNo}`
            : `${SYLLABUS_BASE}/la_syllabus?lectureNo=${matched.lectureNo}`;
          const books = await fetchSyllabusDetail(matched.lectureNo, matched.departmentNo);
          sendResponse({ books, syllabusUrl });
          return;
        }
        // 名前マッチ失敗 → 科目名検索にフォールバック
        console.log("[KULMS] lectureCode search did not match name, falling back to name search");
      }

      const result = await searchSyllabus(keyword, {
        expectedTeacher: lazyTeacher,
      });
      if (!result) {
        sendResponse({ books: [] });
        return;
      }
      const syllabusUrl = result.departmentNo
        ? `${SYLLABUS_BASE}/department_syllabus?lectureNo=${result.lectureNo}&departmentNo=${result.departmentNo}`
        : `${SYLLABUS_BASE}/la_syllabus?lectureNo=${result.lectureNo}`;
      const books = await fetchSyllabusDetail(result.lectureNo, result.departmentNo);
      sendResponse({ books, syllabusUrl });
    } catch (e) {
      console.warn("[KULMS] textbook fetch error:", e.message);
      sendResponse({ books: [], error: e.message });
    }
  })();

  return true; // 非同期レスポンスを示す
});

// === TOTP シークレット暗号化ストア ===
//
// 鍵(AES-GCM, 非抽出)と暗号文を「同一の IndexedDB ストアに、単一トランザクションで
// アトミックに」保存する。以前は鍵を IndexedDB・暗号文を chrome.storage.local に
// 分けて別々のタイミングで書き込んでいたため、片方だけが失われる/入れ替わると
// 復号不能（AES-GCM OperationError）になり、自動入力も popup も無言で停止していた。
// 両者の運命を常に一致させることで desync を構造的に排除する。
// さらに navigator.storage.persist() で eviction からの保護を要求する。

const TOTP_DB_NAME = "kulms-totp-db";
const TOTP_DB_STORE = "keys";
const TOTP_KEY_ID = "totp-aes-key"; // auto モードの CryptoKey(非抽出)
const TOTP_SECRET_ID = "totp-secret"; // auto: { mode, data, iv } / passphrase: { mode, data, iv, salt, iterations }
const TOTP_LEGACY_CIPHER_KEY = "kulms-totp-encrypted"; // 旧: chrome.storage.local

// passphrase モード(PBKDF2 → AES-256-GCM)の定数
const TOTP_PBKDF2_ITERATIONS = 600000; // OWASP 2023 推奨水準
const TOTP_PBKDF2_HASH = "SHA-256";
const TOTP_SALT_BYTES = 16;
const TOTP_IV_BYTES = 12;

// アンロック中の導出鍵キャッシュ(メモリのみ)と自動ロック
const TOTP_SESSION_KEY = "kulms-totp-skey"; // chrome.storage.session: 導出鍵の生バイト(base64)
const TOTP_PENDING_KEY = "kulms-totp-pending"; // chrome.storage.session: 登録中の保留シークレット(平文, メモリのみ)
const TOTP_AUTOLOCK_ALARM = "kulms-totp-autolock";
const TOTP_AUTOLOCK_SETTING = "kulms-totp-autolock-min"; // chrome.storage.local: 分
const TOTP_AUTOLOCK_DEFAULT_MIN = 30; // 0 = ブラウザ終了まで保持

function openTotpDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(TOTP_DB_NAME, 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(TOTP_DB_STORE)) {
        db.createObjectStore(TOTP_DB_STORE);
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

// eviction（容量逼迫時の LRU 削除）からオリジンを除外するよう要求する。
async function ensureTotpPersistence() {
  try {
    if (navigator.storage && navigator.storage.persist) {
      if (!(await navigator.storage.persisted())) {
        await navigator.storage.persist();
      }
    }
  } catch (e) {
    /* persist 非対応環境では何もしない */
  }
}

function idbGet(db, id) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(TOTP_DB_STORE, "readonly");
    const req = tx.objectStore(TOTP_DB_STORE).get(id);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

// 単一トランザクションで複数キーを書き込み、コミット完了(oncomplete)まで待つ。
// req.onsuccess ではなく tx.oncomplete を待つことで、SW 終了などで書き込みが
// 永続化されない（=desync の温床）状態を防ぐ。
function idbPutAll(db, entries) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(TOTP_DB_STORE, "readwrite");
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error || new Error("transaction aborted"));
    const store = tx.objectStore(TOTP_DB_STORE);
    for (const [id, value] of entries) store.put(value, id);
  });
}

function idbDelete(db, id) {
  return new Promise((resolve) => {
    const tx = db.transaction(TOTP_DB_STORE, "readwrite");
    tx.oncomplete = () => resolve();
    tx.onerror = () => resolve();
    tx.onabort = () => resolve();
    tx.objectStore(TOTP_DB_STORE).delete(id);
  });
}

function totpRecordMode(rec) {
  return (rec && rec.mode) || "auto"; // mode 無し(旧レコード)は auto 扱い
}

// auto モードで保存: CryptoKey(なければ生成)と暗号文を同一トランザクションで書き込む。
async function saveTotpSecretAuto(plaintext) {
  await ensureTotpPersistence();
  const db = await openTotpDB();
  try {
    let key = await idbGet(db, TOTP_KEY_ID);
    if (!key) {
      key = await crypto.subtle.generateKey(
        { name: "AES-GCM", length: 256 },
        false, // extractable: false
        ["encrypt", "decrypt"]
      );
    }
    const enc = await encryptSecret(key, plaintext);
    await idbPutAll(db, [
      [TOTP_KEY_ID, key],
      [TOTP_SECRET_ID, { mode: "auto", data: enc.data, iv: enc.iv }],
    ]);
    await chrome.storage.local.remove(TOTP_LEGACY_CIPHER_KEY);
  } finally {
    db.close();
  }
}

function isProtectedFamily(rec) {
  return !!rec && (rec.mode === "protected" || rec.mode === "passphrase");
}

// シークレット保存のエントリポイント。現行モードに応じて分岐する。
// protected モードでは、アンロック済み(session の DEK)か passphrase 指定が必要。
// DEK は据え置きで、暗号文(data/iv)だけを更新する(wrappers は不変=解錠手段を維持)。
async function saveTotpSecret(plaintext, passphrase) {
  const db = await openTotpDB();
  let rec;
  try {
    rec = await idbGet(db, TOTP_SECRET_ID);
  } finally {
    db.close();
  }

  if (isProtectedFamily(rec)) {
    let dek = await getSessionKey();
    if (!dek && passphrase) {
      const u = await unlockPassphrase(passphrase);
      if (!u.ok) return { ok: false, error: "locked" };
      dek = await getSessionKey();
    }
    if (!dek) return { ok: false, error: "locked" };

    const enc = await encryptWithRawKey(dek, plaintext);
    const wrappers =
      rec.wrappers && typeof rec.wrappers === "object" ? rec.wrappers : null;
    await ensureTotpPersistence();
    const db2 = await openTotpDB();
    try {
      if (wrappers) {
        await idbPutAll(db2, [
          [TOTP_SECRET_ID, { mode: "protected", data: enc.data, iv: enc.iv, wrappers }],
        ]);
      } else {
        // 旧形式(mode:"passphrase", data を派生鍵で直接暗号化)の後方互換保存
        await idbPutAll(db2, [
          [
            TOTP_SECRET_ID,
            {
              mode: rec.mode || "passphrase",
              data: enc.data,
              iv: enc.iv,
              salt: rec.salt,
              iterations: rec.iterations || TOTP_PBKDF2_ITERATIONS,
            },
          ],
        ]);
      }
    } finally {
      db2.close();
    }
    await setSessionKey(dek); // アンロック維持＋自動ロック再スケジュール
    return { ok: true };
  }

  await saveTotpSecretAuto(plaintext);
  return { ok: true };
}

// シークレットを読み出す。{ secret, mode, locked } を返す。
// passphrase モードで未アンロックなら secret=null, locked=true。
// auto モードで復号不能(=鍵入れ替わり/破損)なら死んだ暗号文を掃除して secret=null。
async function loadTotpSecretDetailed() {
  await ensureTotpPersistence();
  const db = await openTotpDB();
  try {
    const rec = await idbGet(db, TOTP_SECRET_ID);

    // 旧スキーム(chrome.storage.local, auto 相当)からの移行
    if (!rec) {
      const legacy = (await chrome.storage.local.get(TOTP_LEGACY_CIPHER_KEY))[
        TOTP_LEGACY_CIPHER_KEY
      ];
      if (!legacy) return { secret: null, mode: null, locked: false };
      const key = await idbGet(db, TOTP_KEY_ID);
      if (key) {
        try {
          const secret = await decryptSecret(key, legacy.data, legacy.iv);
          await idbPutAll(db, [
            [TOTP_SECRET_ID, { mode: "auto", data: legacy.data, iv: legacy.iv }],
          ]);
          await chrome.storage.local.remove(TOTP_LEGACY_CIPHER_KEY);
          return { secret, mode: "auto", locked: false };
        } catch (e) {
          /* 復号不能 → 下で掃除 */
        }
      }
      await chrome.storage.local.remove(TOTP_LEGACY_CIPHER_KEY);
      return { secret: null, mode: null, locked: false };
    }

    const mode = totpRecordMode(rec);

    if (mode === "protected" || mode === "passphrase") {
      // protected: session=DEK / 旧passphrase: session=派生鍵。どちらも data を
      // session 鍵で直接復号できる(protected は DEK で、旧は派生鍵で暗号化済み)。
      const sessionKey = await getSessionKey();
      if (!sessionKey) return { secret: null, mode: "protected", locked: true };
      try {
        const secret = await decryptWithRawKey(sessionKey, rec.data, rec.iv);
        return { secret, mode: "protected", locked: false };
      } catch (e) {
        // session 鍵が古い/不整合 → ロック状態に戻す(暗号文は保持=再アンロック可能)
        await clearSessionKey();
        return { secret: null, mode: "protected", locked: true };
      }
    }

    // auto モード
    const key = await idbGet(db, TOTP_KEY_ID);
    if (!key) {
      await idbDelete(db, TOTP_SECRET_ID);
      return { secret: null, mode: "auto", locked: false };
    }
    try {
      const secret = await decryptSecret(key, rec.data, rec.iv);
      return { secret, mode: "auto", locked: false };
    } catch (e) {
      await idbDelete(db, TOTP_SECRET_ID);
      return { secret: null, mode: "auto", locked: false };
    }
  } finally {
    db.close();
  }
}

async function deleteTotpSecret() {
  const db = await openTotpDB();
  try {
    await idbDelete(db, TOTP_SECRET_ID);
    await idbDelete(db, TOTP_KEY_ID);
  } finally {
    db.close();
  }
  await chrome.storage.local.remove(TOTP_LEGACY_CIPHER_KEY);
  await clearSessionKey();
}

// TOTP の状態を返す: { exists, mode, locked }
async function totpStatus() {
  const db = await openTotpDB();
  let rec;
  try {
    rec = await idbGet(db, TOTP_SECRET_ID);
  } finally {
    db.close();
  }
  if (!rec) {
    const legacy = (await chrome.storage.local.get(TOTP_LEGACY_CIPHER_KEY))[
      TOTP_LEGACY_CIPHER_KEY
    ];
    if (legacy) return { exists: true, mode: "auto", locked: false };
    return { exists: false, mode: null, locked: false };
  }
  const mode = totpRecordMode(rec);
  if (mode === "protected" || mode === "passphrase") {
    const sessionKey = await getSessionKey();
    const wa = rec.wrappers && rec.wrappers.webauthn ? rec.wrappers.webauthn : null;
    return {
      exists: true,
      mode: "protected",
      locked: !sessionKey,
      methods: { passphrase: true, webauthn: !!wa },
    };
  }
  // auto: 復号可否まで含めて判定(死んだ暗号文は loadTotpSecretDetailed が掃除)
  const d = await loadTotpSecretDetailed();
  return { exists: !!d.secret, mode: "auto", locked: false };
}

// === passphrase モードの鍵導出・暗号化 ===

function bytesToB64(buf) {
  return btoa(String.fromCharCode(...new Uint8Array(buf)));
}
function b64ToBytes(b64) {
  return Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
}

// PBKDF2 でパスフレーズ + salt から生の 256bit 鍵を導出する。
async function deriveRawKey(passphrase, saltBytes, iterations) {
  const baseKey = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(passphrase),
    "PBKDF2",
    false,
    ["deriveBits"]
  );
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", salt: saltBytes, iterations, hash: TOTP_PBKDF2_HASH },
    baseKey,
    256
  );
  return new Uint8Array(bits);
}

async function importAesKey(rawKey) {
  return crypto.subtle.importKey("raw", rawKey, { name: "AES-GCM" }, false, [
    "encrypt",
    "decrypt",
  ]);
}

async function encryptWithRawKey(rawKey, plaintext) {
  const key = await importAesKey(rawKey);
  const iv = crypto.getRandomValues(new Uint8Array(TOTP_IV_BYTES));
  const cipherBuffer = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv },
    key,
    new TextEncoder().encode(plaintext)
  );
  return { data: bytesToB64(cipherBuffer), iv: bytesToB64(iv) };
}

async function decryptWithRawKey(rawKey, dataB64, ivB64) {
  const key = await importAesKey(rawKey);
  const plainBuffer = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: b64ToBytes(ivB64) },
    key,
    b64ToBytes(dataB64)
  );
  return new TextDecoder().decode(plainBuffer);
}

// WebAuthn の PRF 出力(生体認証)から HKDF-SHA256 でラップ用 256bit 鍵を導出する。
async function deriveKeyFromPrf(prfBytes, saltBytes) {
  const base = await crypto.subtle.importKey("raw", prfBytes, "HKDF", false, [
    "deriveBits",
  ]);
  const bits = await crypto.subtle.deriveBits(
    {
      name: "HKDF",
      hash: "SHA-256",
      salt: saltBytes,
      info: new TextEncoder().encode("kulms-totp-webauthn"),
    },
    base,
    256
  );
  return new Uint8Array(bits);
}

// パスフレーズで保護(protected エンベロープ)に切替 / パスフレーズ変更。
// ランダム DEK で秘密を暗号化し、DEK を PBKDF2(passphrase) でラップする。
// 既存が protected でアンロック済みなら DEK と webauthn ラッパーを引き継ぐ
// (＝パスフレーズ変更後も生体認証はそのまま使える)。
async function setPassphrase(passphrase) {
  if (!passphrase) return { ok: false, error: "empty" };
  const cur = await loadTotpSecretDetailed();
  if (!cur.secret) {
    return { ok: false, error: cur.locked ? "locked" : "no-secret" };
  }

  const db0 = await openTotpDB();
  let rec;
  try {
    rec = await idbGet(db0, TOTP_SECRET_ID);
  } finally {
    db0.close();
  }

  let dek = null;
  let keepWebauthn = null;
  if (rec && rec.mode === "protected") {
    dek = await getSessionKey(); // cur.secret が取れた=アンロック済み
    if (rec.wrappers && rec.wrappers.webauthn) keepWebauthn = rec.wrappers.webauthn;
  }
  if (!dek) dek = crypto.getRandomValues(new Uint8Array(32));

  const enc = await encryptWithRawKey(dek, cur.secret); // 秘密を DEK で暗号化
  const salt = crypto.getRandomValues(new Uint8Array(TOTP_SALT_BYTES));
  const wrapKey = await deriveRawKey(passphrase, salt, TOTP_PBKDF2_ITERATIONS);
  const wrap = await encryptWithRawKey(wrapKey, bytesToB64(dek)); // DEK をラップ

  const wrappers = {
    passphrase: {
      salt: bytesToB64(salt),
      iterations: TOTP_PBKDF2_ITERATIONS,
      data: wrap.data,
      iv: wrap.iv,
    },
  };
  if (keepWebauthn) wrappers.webauthn = keepWebauthn;

  await ensureTotpPersistence();
  const db = await openTotpDB();
  try {
    await idbPutAll(db, [
      [TOTP_SECRET_ID, { mode: "protected", data: enc.data, iv: enc.iv, wrappers }],
    ]);
    await idbDelete(db, TOTP_KEY_ID); // auto の CryptoKey は不要
  } finally {
    db.close();
  }
  await chrome.storage.local.remove(TOTP_LEGACY_CIPHER_KEY);
  await setSessionKey(dek); // 設定直後はアンロック状態
  return { ok: true };
}

// 保護(パスフレーズ＋生体)を解除して auto モードへ戻す(wrappers ごと破棄)。
async function removePassphrase(passphrase) {
  let secret = null;
  const cur = await loadTotpSecretDetailed();
  if (cur.secret) {
    secret = cur.secret;
  } else if (cur.locked && passphrase) {
    const u = await unlockPassphrase(passphrase);
    if (!u.ok) return { ok: false, error: "wrong-passphrase" };
    const cur2 = await loadTotpSecretDetailed();
    secret = cur2.secret;
  }
  if (!secret) return { ok: false, error: "locked" };
  await saveTotpSecretAuto(secret); // {mode:"auto"} + 新規 CryptoKey
  await clearSessionKey();
  return { ok: true };
}

// パスフレーズでアンロック: DEK を復元して session にキャッシュ。
// protected: passphrase ラッパーから DEK をアンラップ。
// 旧 passphrase 形式(未リリース): 派生鍵で data を検証 → protected へ移行。
async function unlockPassphrase(passphrase) {
  if (!passphrase) return { ok: false, error: "empty" };
  const db = await openTotpDB();
  let rec;
  try {
    rec = await idbGet(db, TOTP_SECRET_ID);
  } finally {
    db.close();
  }
  if (!isProtectedFamily(rec)) return { ok: false, error: "not-protected" };

  if (rec.mode === "protected") {
    const w = rec.wrappers && rec.wrappers.passphrase;
    if (!w) return { ok: false, error: "no-passphrase-wrapper" };
    const wrapKey = await deriveRawKey(
      passphrase,
      b64ToBytes(w.salt),
      w.iterations || TOTP_PBKDF2_ITERATIONS
    );
    let dekB64;
    try {
      // AES-GCM の認証タグが検証子。誤パスフレーズなら例外。
      dekB64 = await decryptWithRawKey(wrapKey, w.data, w.iv);
    } catch (e) {
      return { ok: false, error: "wrong-passphrase" };
    }
    await setSessionKey(b64ToBytes(dekB64));
    return { ok: true };
  }

  // 旧 passphrase 形式: data を派生鍵で直接復号して検証
  const derived = await deriveRawKey(
    passphrase,
    b64ToBytes(rec.salt),
    rec.iterations || TOTP_PBKDF2_ITERATIONS
  );
  try {
    await decryptWithRawKey(derived, rec.data, rec.iv);
  } catch (e) {
    return { ok: false, error: "wrong-passphrase" };
  }
  await setSessionKey(derived);
  // protected エンベロープへ移行(best-effort)
  try {
    await setPassphrase(passphrase);
  } catch (e) {
    /* 移行失敗でも解錠は成立 */
  }
  return { ok: true };
}

// === WebAuthn(PRF, 生体認証) 解錠 ===
// 儀式(navigator.credentials.create/get)は DOM とユーザー操作が要るため
// 専用ページ(totp-unlock.html)で実行し、PRF 出力だけをここへ渡す。

// 解錠ページが使うための情報(登録済みクレデンシャル ID と PRF salt)を返す。
async function getWebauthnInfo() {
  const db = await openTotpDB();
  let rec;
  try {
    rec = await idbGet(db, TOTP_SECRET_ID);
  } finally {
    db.close();
  }
  const w = rec && rec.wrappers && rec.wrappers.webauthn;
  if (!w) return { hasWebauthn: false };
  return { hasWebauthn: true, credentialId: w.credentialId, prfSalt: w.prfSalt };
}

// 生体認証を追加: アンロック済み(session の DEK)必須。PRF 出力で DEK をラップして保存。
async function addWebauthn(prfOutputB64, credentialId, prfSalt) {
  if (!prfOutputB64 || !credentialId || !prfSalt) return { ok: false, error: "bad-args" };
  const db0 = await openTotpDB();
  let rec;
  try {
    rec = await idbGet(db0, TOTP_SECRET_ID);
  } finally {
    db0.close();
  }
  if (!rec || rec.mode !== "protected") return { ok: false, error: "not-protected" };
  const dek = await getSessionKey();
  if (!dek) return { ok: false, error: "locked" };

  const wrapKey = await deriveKeyFromPrf(b64ToBytes(prfOutputB64), b64ToBytes(prfSalt));
  const wrap = await encryptWithRawKey(wrapKey, bytesToB64(dek));
  const wrappers = Object.assign({}, rec.wrappers, {
    webauthn: { credentialId, prfSalt, data: wrap.data, iv: wrap.iv },
  });
  const db = await openTotpDB();
  try {
    await idbPutAll(db, [
      [TOTP_SECRET_ID, { mode: "protected", data: rec.data, iv: rec.iv, wrappers }],
    ]);
  } finally {
    db.close();
  }
  await setSessionKey(dek); // 自動ロック再スケジュール
  return { ok: true };
}

// 生体認証でアンロック: PRF 出力から DEK をアンラップして session にキャッシュ。
async function unlockWebauthn(prfOutputB64) {
  if (!prfOutputB64) return { ok: false, error: "bad-args" };
  const db = await openTotpDB();
  let rec;
  try {
    rec = await idbGet(db, TOTP_SECRET_ID);
  } finally {
    db.close();
  }
  const w = rec && rec.wrappers && rec.wrappers.webauthn;
  if (!rec || rec.mode !== "protected" || !w) return { ok: false, error: "no-webauthn" };
  const wrapKey = await deriveKeyFromPrf(b64ToBytes(prfOutputB64), b64ToBytes(w.prfSalt));
  let dekB64;
  try {
    dekB64 = await decryptWithRawKey(wrapKey, w.data, w.iv);
  } catch (e) {
    return { ok: false, error: "unlock-failed" };
  }
  await setSessionKey(b64ToBytes(dekB64));
  return { ok: true };
}

// 生体認証だけを解除(パスフレーズ保護は残す)。
async function removeWebauthn() {
  const db0 = await openTotpDB();
  let rec;
  try {
    rec = await idbGet(db0, TOTP_SECRET_ID);
  } finally {
    db0.close();
  }
  if (!rec || rec.mode !== "protected" || !rec.wrappers) return { ok: true };
  const wrappers = Object.assign({}, rec.wrappers);
  delete wrappers.webauthn;
  const db = await openTotpDB();
  try {
    await idbPutAll(db, [
      [TOTP_SECRET_ID, { mode: "protected", data: rec.data, iv: rec.iv, wrappers }],
    ]);
  } finally {
    db.close();
  }
  return { ok: true };
}

// === セッション鍵キャッシュ & 自動ロック ===

async function getAutolockMinutes() {
  const v = (await chrome.storage.local.get(TOTP_AUTOLOCK_SETTING))[
    TOTP_AUTOLOCK_SETTING
  ];
  return typeof v === "number" && v >= 0 ? v : TOTP_AUTOLOCK_DEFAULT_MIN;
}

async function scheduleAutolock() {
  try {
    await chrome.alarms.clear(TOTP_AUTOLOCK_ALARM);
    const min = await getAutolockMinutes();
    if (min > 0) chrome.alarms.create(TOTP_AUTOLOCK_ALARM, { delayInMinutes: min });
  } catch (e) {
    /* alarms 非対応環境では自動ロックなし(session はブラウザ終了で消える) */
  }
}

async function setSessionKey(rawKey) {
  try {
    await chrome.storage.session.set({ [TOTP_SESSION_KEY]: bytesToB64(rawKey) });
  } catch (e) {
    /* session 非対応環境では都度アンロックになる */
  }
  await scheduleAutolock();
}

async function getSessionKey() {
  try {
    const b64 = (await chrome.storage.session.get(TOTP_SESSION_KEY))[
      TOTP_SESSION_KEY
    ];
    return b64 ? b64ToBytes(b64) : null;
  } catch (e) {
    return null;
  }
}

async function clearSessionKey() {
  try {
    await chrome.storage.session.remove(TOTP_SESSION_KEY);
  } catch (e) {
    /* noop */
  }
  try {
    await chrome.alarms.clear(TOTP_AUTOLOCK_ALARM);
  } catch (e) {
    /* noop */
  }
}

if (chrome.alarms && chrome.alarms.onAlarm) {
  chrome.alarms.onAlarm.addListener((alarm) => {
    if (alarm && alarm.name === TOTP_AUTOLOCK_ALARM) clearSessionKey();
  });
}

// === 登録フローの保留シークレット(メモリのみ) ===
// 京大の登録ページで読み取ったシークレットを、登録完了ページに遷移するまで
// chrome.storage.session に保持する。ページの sessionStorage に平文を置かないための橋渡し。
async function setPendingSecret(secret) {
  try {
    await chrome.storage.session.set({ [TOTP_PENDING_KEY]: secret });
  } catch (e) {
    /* noop */
  }
}

async function commitPendingSecret() {
  let pending = null;
  try {
    pending = (await chrome.storage.session.get(TOTP_PENDING_KEY))[TOTP_PENDING_KEY];
  } catch (e) {
    /* noop */
  }
  if (!pending) return { ok: false, error: "no-pending" };
  const r = await saveTotpSecret(pending);
  // 保存できた場合のみ保留を破棄する(passphrase ロック中などは保留を残して再試行可能に)。
  if (r && r.ok) {
    try {
      await chrome.storage.session.remove(TOTP_PENDING_KEY);
    } catch (e) {
      /* noop */
    }
  }
  return r;
}

async function encryptSecret(key, plaintext) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encoded = new TextEncoder().encode(plaintext);
  const cipherBuffer = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv },
    key,
    encoded
  );
  return {
    data: btoa(String.fromCharCode(...new Uint8Array(cipherBuffer))),
    iv: btoa(String.fromCharCode(...iv)),
  };
}

async function decryptSecret(key, data, iv) {
  const cipherBytes = Uint8Array.from(atob(data), (c) => c.charCodeAt(0));
  const ivBytes = Uint8Array.from(atob(iv), (c) => c.charCodeAt(0));
  const plainBuffer = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: ivBytes },
    key,
    cipherBytes
  );
  return new TextDecoder().decode(plainBuffer);
}

// 送信元の検証。onMessage は本拡張自身のコンテキスト(注入したコンテンツスクリプト＋
// 拡張ページ)からしか届かない(externally_connectable 未設定)が、多層防御として
// 許可オリジンを明示する: 拡張自身のページ(popup 等)と、本拡張がコンテンツスクリプトを
// 注入している京大ドメイン(認証ページと LMS)のみ。それ以外(host_permissions だけ持つ
// www.k / github.io など)は拒否する。
function isAllowedTotpSender(sender) {
  if (!sender) return false;
  const url = sender.url || "";
  if (url.startsWith(chrome.runtime.getURL(""))) return true; // popup / 拡張ページ
  if (
    sender.tab &&
    (url.startsWith("https://auth.iimc.kyoto-u.ac.jp/") ||
      url.startsWith("https://lms.gakusei.kyoto-u.ac.jp/"))
  ) {
    return true; // auth-totp*.js / assignments.js(LMS 内の設定UI)
  }
  return false;
}

// TOTP メッセージハンドラ
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || !message.type || !message.type.startsWith("kulms-totp-")) return false;

  if (!isAllowedTotpSender(sender)) {
    sendResponse({ error: "forbidden" });
    return true;
  }

  (async () => {
    try {
      switch (message.type) {
        case "kulms-totp-save": {
          sendResponse(await saveTotpSecret(message.secret, message.passphrase));
          break;
        }
        case "kulms-totp-pending-set": {
          await setPendingSecret(message.secret);
          sendResponse({ ok: true });
          break;
        }
        case "kulms-totp-pending-commit": {
          sendResponse(await commitPendingSecret());
          break;
        }
        case "kulms-totp-load": {
          const d = await loadTotpSecretDetailed();
          sendResponse({ secret: d.secret || null, mode: d.mode, locked: !!d.locked });
          break;
        }
        case "kulms-totp-unlock": {
          sendResponse(await unlockPassphrase(message.passphrase));
          break;
        }
        case "kulms-totp-lock": {
          await clearSessionKey();
          sendResponse({ ok: true });
          break;
        }
        case "kulms-totp-set-passphrase": {
          sendResponse(await setPassphrase(message.passphrase));
          break;
        }
        case "kulms-totp-remove-passphrase": {
          sendResponse(await removePassphrase(message.passphrase));
          break;
        }
        case "kulms-totp-get-webauthn": {
          sendResponse(await getWebauthnInfo());
          break;
        }
        case "kulms-totp-webauthn-add": {
          sendResponse(
            await addWebauthn(message.prfOutput, message.credentialId, message.prfSalt)
          );
          break;
        }
        case "kulms-totp-webauthn-unlock": {
          sendResponse(await unlockWebauthn(message.prfOutput));
          break;
        }
        case "kulms-totp-webauthn-remove": {
          await removeWebauthn();
          sendResponse({ ok: true });
          break;
        }
        case "kulms-totp-delete": {
          await deleteTotpSecret();
          sendResponse({ ok: true });
          break;
        }
        case "kulms-totp-has":
        case "kulms-totp-status": {
          sendResponse(await totpStatus());
          break;
        }
        case "kulms-totp-set-autolock": {
          const min = Number(message.minutes);
          await chrome.storage.local.set({
            [TOTP_AUTOLOCK_SETTING]:
              isFinite(min) && min >= 0 ? min : TOTP_AUTOLOCK_DEFAULT_MIN,
          });
          if (await getSessionKey()) await scheduleAutolock();
          sendResponse({ ok: true });
          break;
        }
        case "kulms-totp-get-autolock": {
          sendResponse({ minutes: await getAutolockMinutes() });
          break;
        }
        default:
          sendResponse({ error: "unknown type" });
      }
    } catch (e) {
      console.warn("[KULMS] TOTP message handler error:", e.message);
      sendResponse({ error: e.message });
    }
  })();

  return true; // 非同期レスポンス
});
