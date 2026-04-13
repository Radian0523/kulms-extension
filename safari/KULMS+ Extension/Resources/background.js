// KULMS Background Service Worker

// インストール/更新時にキャッシュをクリア
chrome.runtime.onInstalled.addListener(() => {
  chrome.storage.local.remove(["kulms-syllabus-catalog", "kulms-textbooks"]);
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
// KULASIS は "久門 尚史"、Sakai は "久門尚史" と表記揺れがあるため
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
