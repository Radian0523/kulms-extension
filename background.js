// KULMS Background Service Worker

// インストール/更新時にキャッシュをクリア
chrome.runtime.onInstalled.addListener(() => {
  chrome.storage.local.remove(["kulms-syllabus-catalog", "kulms-textbooks"]);
});

// === シラバス教科書取得ハンドラ ===

const SYLLABUS_BASE = "https://www.k.kyoto-u.ac.jp/external/open_syllabus";

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
async function searchSyllabus(keyword) {
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

    // 最初の非空セルが科目名
    const name = cells[0] || "";
    if (name) {
      results.push({ lectureNo, departmentNo, name });
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

  const normalized = normalizeForMatch(keyword);

  // 完全一致（正規化後）
  const exact = results.find(
    (r) => normalizeForMatch(r.name) === normalized
  );
  if (exact) {
    console.log("[KULMS] exact match:", exact.name, exact.lectureNo);
    return { lectureNo: exact.lectureNo, departmentNo: exact.departmentNo };
  }

  // 部分一致
  const partial = results.find((r) => {
    const rn = normalizeForMatch(r.name);
    return rn.includes(normalized) || normalized.includes(rn);
  });
  if (partial) {
    console.log("[KULMS] partial match:", partial.name, partial.lectureNo);
    return { lectureNo: partial.lectureNo, departmentNo: partial.departmentNo };
  }

  // 検索エンジンが返した最初の結果を使用
  console.log(
    "[KULMS] using first result:",
    results[0].name,
    results[0].lectureNo
  );
  return { lectureNo: results[0].lectureNo, departmentNo: results[0].departmentNo };
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
  if (!courseName) {
    sendResponse({ books: [] });
    return false;
  }

  const keyword = cleanCourseName(courseName);
  if (!keyword) {
    sendResponse({ books: [] });
    return false;
  }

  (async () => {
    try {
      const result = await searchSyllabus(keyword);
      if (!result) {
        sendResponse({ books: [] });
        return;
      }
      const books = await fetchSyllabusDetail(result.lectureNo, result.departmentNo);
      sendResponse({ books });
    } catch (e) {
      console.warn("[KULMS] textbook fetch error:", e.message);
      sendResponse({ books: [], error: e.message });
    }
  })();

  return true; // 非同期レスポンスを示す
});
