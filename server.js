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

// Decode raw RSS buffer to string with proper encoding detection
function decodeRSSBuffer(buf, headers) {
  const contentType = (headers && headers["content-type"]) || "";
  const rawPreview = buf.toString("ascii", 0, Math.min(buf.length, 300));

  let encoding = "utf-8";

  // Check Content-Type header for charset
  const charsetMatch = contentType.match(/charset=([^\s;]+)/i);
  if (charsetMatch) {
    encoding = charsetMatch[1].toLowerCase().replace(/^"/, "").replace(/"$/, "");
  }

  // Check XML declaration for encoding (takes priority)
  const xmlEncodingMatch = rawPreview.match(/encoding=["']([^"']+)["']/i);
  if (xmlEncodingMatch) {
    encoding = xmlEncodingMatch[1].toLowerCase();
  }

  console.log(`Detected encoding: ${encoding}`);

  let data;
  try {
    data = iconv.decode(buf, encoding);
  } catch {
    try {
      data = iconv.decode(buf, "windows-1255");
    } catch {
      data = buf.toString("utf-8");
    }
  }

  // Strip BOM if present
  if (data.charCodeAt(0) === 0xfeff) {
    data = data.slice(1);
  }

  return data;
}

// Parse RSS XML string into news items
function parseRSSItems(result) {
  if (!result?.rss?.channel?.item) {
    return [];
  }

  const items = Array.isArray(result.rss.channel.item)
    ? result.rss.channel.item
    : [result.rss.channel.item];

  return items.map((item) => ({
    title: item.title || "",
    description: (item.description || "").replace(/<[^>]*>/g, "").trim(),
    link: item.link || "",
    pubDate: item.pubDate || "",
  }));
}

// Strategy 1: Fetch RSS directly from Ynet
async function fetchRSSDirect(feedUrl) {
  const response = await axios.get(feedUrl, {
    responseType: "arraybuffer",
    timeout: 10000,
    headers: {
      "User-Agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
      Accept:
        "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      "Accept-Language": "he-IL,he;q=0.9,en;q=0.8",
    },
  });

  const buf = Buffer.from(response.data);
  const data = decodeRSSBuffer(buf, response.headers);

  const parser = new xml2js.Parser({ explicitArray: false });
  const result = await parser.parseStringPromise(data);
  return parseRSSItems(result);
}

// Strategy 2: Use allorigins.win as a raw proxy (preserves original bytes)
async function fetchRSSViaRawProxy(feedUrl) {
  const proxyUrl = `https://api.allorigins.win/raw?url=${encodeURIComponent(feedUrl)}`;
  const response = await axios.get(proxyUrl, {
    responseType: "arraybuffer",
    timeout: 15000,
  });

  const buf = Buffer.from(response.data);
  const data = decodeRSSBuffer(buf, response.headers);

  const parser = new xml2js.Parser({ explicitArray: false });
  const result = await parser.parseStringPromise(data);
  return parseRSSItems(result);
}

// Strategy 3: Use corsproxy.io as another raw proxy
async function fetchRSSViaCorsProxy(feedUrl) {
  const proxyUrl = `https://corsproxy.io/?${encodeURIComponent(feedUrl)}`;
  const response = await axios.get(proxyUrl, {
    responseType: "arraybuffer",
    timeout: 15000,
  });

  const buf = Buffer.from(response.data);
  const data = decodeRSSBuffer(buf, response.headers);

  const parser = new xml2js.Parser({ explicitArray: false });
  const result = await parser.parseStringPromise(data);
  return parseRSSItems(result);
}

// Try all strategies in order
async function fetchRSS(feedUrl) {
  const strategies = [
    { name: "direct", fn: fetchRSSDirect },
    { name: "allorigins", fn: fetchRSSViaRawProxy },
    { name: "corsproxy", fn: fetchRSSViaCorsProxy },
  ];

  for (const strategy of strategies) {
    try {
      const items = await strategy.fn(feedUrl);
      if (items.length > 0) {
        console.log(`[${strategy.name}] Success for ${feedUrl}: ${items.length} items`);
        return items;
      }
    } catch (err) {
      console.log(`[${strategy.name}] Failed for ${feedUrl}: ${err.message}`);
    }
  }

  console.error(`All strategies failed for ${feedUrl}`);
  return [];
}

// API endpoint to get news
app.get("/api/news", async (req, res) => {
  res.set("Content-Type", "application/json; charset=utf-8");
  try {
    const feedPromises = RSS_FEEDS.map(async (feed) => {
      const items = await fetchRSS(feed.url);
      return { category: feed.name, items: items.slice(0, 10) };
    });

    const results = await Promise.all(feedPromises);

    // Filter out empty feeds
    const feeds = results.filter((r) => r.items.length > 0);

    if (feeds.length === 0) {
      return res.json({
        feeds: [],
        fetchedAt: new Date().toISOString(),
        error:
          "לא ניתן לגשת לפיד RSS של Ynet כרגע. נסו שוב מאוחר יותר.",
      });
    }

    res.json({
      feeds,
      fetchedAt: new Date().toISOString(),
    });
  } catch (err) {
    console.error("Error in /api/news:", err.message);
    res.status(500).json({
      error: "שגיאה בטעינת החדשות",
    });
  }
});

// Serve main page
app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

app.listen(PORT, () => {
  console.log(`Server running at http://localhost:${PORT}`);
});
