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

// Try fetching RSS directly from Ynet
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

  // Ynet RSS is typically windows-1255 encoded
  let data;
  try {
    data = iconv.decode(Buffer.from(response.data), "windows-1255");
  } catch {
    data = response.data.toString("utf-8");
  }

  const parser = new xml2js.Parser({ explicitArray: false });
  const result = await parser.parseStringPromise(data);

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

// Fallback: use rss2json public API as a proxy
async function fetchRSSViaProxy(feedUrl) {
  const proxyUrl = `https://api.rss2json.com/v1/api.json?rss_url=${encodeURIComponent(feedUrl)}`;
  const response = await axios.get(proxyUrl, { timeout: 10000 });

  if (response.data.status !== "ok" || !response.data.items) {
    return [];
  }

  return response.data.items.map((item) => ({
    title: item.title || "",
    description: (item.description || "").replace(/<[^>]*>/g, "").trim(),
    link: item.link || "",
    pubDate: item.pubDate || "",
  }));
}

async function fetchRSS(feedUrl) {
  // Try direct fetch first, then fallback to proxy
  try {
    return await fetchRSSDirect(feedUrl);
  } catch (directErr) {
    console.log(`Direct fetch failed for ${feedUrl}: ${directErr.message}, trying proxy...`);
    try {
      return await fetchRSSViaProxy(feedUrl);
    } catch (proxyErr) {
      console.error(`Proxy fetch also failed for ${feedUrl}: ${proxyErr.message}`);
      return [];
    }
  }
}

// API endpoint to get news
app.get("/api/news", async (req, res) => {
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
