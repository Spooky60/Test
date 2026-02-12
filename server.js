const express = require("express");
const axios = require("axios");
const xml2js = require("xml2js");
const iconv = require("iconv-lite");
const path = require("path");

const app = express();
const PORT = process.env.PORT || 3000;

// Serve static files
app.use(express.static(path.join(__dirname, "public")));

// Ynet RSS feeds (various sections)
const RSS_FEEDS = [
  {
    name: "ראשי",
    url: "https://www.ynet.co.il/Integration/StoryRss2.xml",
  },
  {
    name: "חדשות",
    url: "https://www.ynet.co.il/Integration/StoryRss1.xml",
  },
  {
    name: "כלכלה",
    url: "https://www.ynet.co.il/Integration/StoryRss6.xml",
  },
  {
    name: "ספורט",
    url: "https://www.ynet.co.il/Integration/StoryRss3.xml",
  },
  {
    name: "בריאות",
    url: "https://www.ynet.co.il/Integration/StoryRss4.xml",
  },
];

// All supported encodings for manual selection
const SUPPORTED_ENCODINGS = [
  "auto",
  "utf-8",
  "windows-1255",
  "iso-8859-8",
  "iso-8859-8-i",
  "windows-1252",
  "latin1",
];

// Check if a string contains Hebrew characters (U+0590 - U+05FF)
function containsHebrew(str) {
  let count = 0;
  for (let i = 0; i < Math.min(str.length, 5000); i++) {
    const code = str.charCodeAt(i);
    if (code >= 0x0590 && code <= 0x05ff) count++;
  }
  return count;
}

// Decode buffer with a specific forced encoding
function decodeWithEncoding(buf, encoding) {
  let data;
  try {
    data = iconv.decode(buf, encoding);
  } catch {
    data = buf.toString("utf-8");
  }

  // Strip BOM
  if (data.charCodeAt(0) === 0xfeff) {
    data = data.slice(1);
  }

  // Fix XML encoding declaration
  data = data.replace(
    /(<\?xml[^?]*?)encoding=["'][^"']*["']/i,
    '$1encoding="UTF-8"'
  );

  return data;
}

// Auto-detect encoding by trying multiple and picking best
function decodeRSSBufferAuto(buf) {
  const candidates = ["utf-8", "windows-1255", "iso-8859-8", "iso-8859-8-i"];
  let bestData = null;
  let bestCount = -1;
  let bestEnc = "utf-8";

  for (const enc of candidates) {
    try {
      const decoded = decodeWithEncoding(buf, enc);
      const count = containsHebrew(decoded);
      console.log(`  Encoding ${enc}: ${count} Hebrew chars`);
      if (count > bestCount) {
        bestCount = count;
        bestData = decoded;
        bestEnc = enc;
      }
    } catch {
      // skip
    }
  }

  console.log(`  -> Auto-chose: ${bestEnc} (${bestCount} Hebrew chars)`);
  return bestData || buf.toString("utf-8");
}

// Fetch raw RSS bytes using multiple strategies
async function fetchRSSRaw(feedUrl) {
  const strategies = [
    {
      name: "direct",
      url: feedUrl,
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        Accept: "application/xml,text/xml,*/*;q=0.8",
        "Accept-Language": "he-IL,he;q=0.9,en;q=0.8",
      },
    },
    {
      name: "allorigins",
      url: `https://api.allorigins.win/raw?url=${encodeURIComponent(feedUrl)}`,
    },
    {
      name: "corsproxy",
      url: `https://corsproxy.io/?${encodeURIComponent(feedUrl)}`,
    },
  ];

  for (const s of strategies) {
    try {
      const response = await axios.get(s.url, {
        responseType: "arraybuffer",
        timeout: 12000,
        headers: s.headers || {},
      });
      const buf = Buffer.from(response.data);
      if (buf.length > 100) {
        console.log(`[${s.name}] Got ${buf.length} bytes for ${feedUrl}`);
        return { buf, strategy: s.name };
      }
    } catch (err) {
      console.log(`[${s.name}] Failed: ${err.message}`);
    }
  }

  throw new Error("All fetch strategies failed");
}

// Parse RSS XML string into items
function parseRSSItems(xmlString) {
  const parser = new xml2js.Parser({ explicitArray: false });
  return parser.parseStringPromise(xmlString).then((result) => {
    if (!result?.rss?.channel?.item) return [];

    const items = Array.isArray(result.rss.channel.item)
      ? result.rss.channel.item
      : [result.rss.channel.item];

    return items.map((item) => ({
      title: item.title || "",
      description: (item.description || "").replace(/<[^>]*>/g, "").trim(),
      link: item.link || "",
      pubDate: item.pubDate || "",
    }));
  });
}

// API endpoint to get news with optional encoding override
app.get("/api/news", async (req, res) => {
  res.set("Content-Type", "application/json; charset=utf-8");

  const forcedEncoding = req.query.encoding || "auto";
  console.log(`\n=== Fetching news (encoding: ${forcedEncoding}) ===`);

  try {
    const feedPromises = RSS_FEEDS.map(async (feed) => {
      try {
        const { buf, strategy } = await fetchRSSRaw(feed.url);

        let xmlString;
        if (forcedEncoding === "auto") {
          xmlString = decodeRSSBufferAuto(buf);
        } else {
          xmlString = decodeWithEncoding(buf, forcedEncoding);
          const hCount = containsHebrew(xmlString);
          console.log(`  Forced ${forcedEncoding}: ${hCount} Hebrew chars`);
        }

        const items = await parseRSSItems(xmlString);
        return { category: feed.name, items: items.slice(0, 10), strategy };
      } catch (err) {
        console.log(`Feed ${feed.name} failed: ${err.message}`);
        return { category: feed.name, items: [] };
      }
    });

    const results = await Promise.all(feedPromises);
    const feeds = results.filter((r) => r.items.length > 0);

    if (feeds.length === 0) {
      return res.json({
        feeds: [],
        encoding: forcedEncoding,
        fetchedAt: new Date().toISOString(),
        error: "לא ניתן לגשת לפיד RSS של Ynet כרגע. נסו שוב מאוחר יותר.",
      });
    }

    res.json({
      feeds,
      encoding: forcedEncoding,
      fetchedAt: new Date().toISOString(),
    });
  } catch (err) {
    console.error("Error in /api/news:", err.message);
    res.status(500).json({ error: "שגיאה בטעינת החדשות" });
  }
});

// Debug endpoint: show raw bytes info for the first feed
app.get("/api/debug", async (req, res) => {
  res.set("Content-Type", "application/json; charset=utf-8");
  const feedUrl = RSS_FEEDS[0].url;

  try {
    const { buf, strategy } = await fetchRSSRaw(feedUrl);

    const debugInfo = {
      feedUrl,
      strategy,
      byteLength: buf.length,
      firstBytes: Array.from(buf.slice(0, 50)).map((b) => b.toString(16).padStart(2, "0")).join(" "),
      encodings: {},
    };

    for (const enc of ["utf-8", "windows-1255", "iso-8859-8", "iso-8859-8-i", "latin1"]) {
      try {
        const decoded = iconv.decode(buf, enc);
        const hebrewCount = containsHebrew(decoded);
        // Show first 200 chars of the decoded content (after XML header)
        const contentStart = decoded.indexOf("<title>");
        const sample = contentStart >= 0
          ? decoded.substring(contentStart, contentStart + 200)
          : decoded.substring(0, 200);
        debugInfo.encodings[enc] = { hebrewCount, sample };
      } catch {
        debugInfo.encodings[enc] = { error: "decode failed" };
      }
    }

    res.json(debugInfo);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Serve main page
app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

app.listen(PORT, () => {
  console.log(`Server running at http://localhost:${PORT}`);
});
