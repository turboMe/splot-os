---
name: web-scraper
category: coding
description: >-
  Extract structured data from web pages using curl, wget, and text processing.
  Handles pagination, anti-bot headers, and data normalization into JSON/CSV.
  Use when agent needs to scrape web content, extract data from HTML pages,
  or build ETL pipelines from web sources.
keywords: [scraping, web, curl, html, extraction, parsing, etl, data]
allowedTools: [shell_execute, fs_write_file, fs_read_file]
minComplexity: moderate
recommendedTier: pro
estimatedTokens: 1350
outputFormat: json
tags: [coding, web, data-extraction, etl]
version: 1
success_rate: null
total_uses: 0
last_used: null
handoffCapable: true
---
# Web Scraper

## Trigger
Agent needs to extract structured data from web pages, download content,
parse HTML into usable formats, or build data pipelines from web sources.

## Procedure

### Step 1: Reconnaissance

Before scraping, gather information:
1. **Check `robots.txt`:**
   ```bash
   curl -s "https://example.com/robots.txt" | head -20
   ```
2. **Inspect the target page:**
   ```bash
   # Get headers (check Content-Type, encoding, rate limiting)
   curl -sI "https://example.com/page"

   # Get page source (first 100 lines)
   curl -s "https://example.com/page" | head -100
   ```
3. **Determine data location:**
   - Static HTML (server-rendered) → curl + text processing
   - JavaScript-rendered (SPA) → Needs headless browser (Playwright)
   - API endpoint → Direct JSON fetch (see api-tester skill)

### Step 2: Fetch with proper headers

**Always set a realistic User-Agent to avoid blocks:**
```bash
UA="Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36"

# Basic fetch with anti-bot headers
curl -s \
  -H "User-Agent: $UA" \
  -H "Accept: text/html,application/xhtml+xml" \
  -H "Accept-Language: en-US,en;q=0.9" \
  "https://example.com/page" > page.html
```

**Handle redirects and cookies:**
```bash
# Follow redirects, save cookies
curl -s -L \
  -H "User-Agent: $UA" \
  -c cookies.txt \
  "https://example.com/login-redirect" > page.html

# Use saved cookies for subsequent requests
curl -s \
  -H "User-Agent: $UA" \
  -b cookies.txt \
  "https://example.com/protected-page" > protected.html
```

### Step 3: Extract data from HTML

**Using grep/sed for simple patterns:**
```bash
# Extract all links
grep -oP 'href="([^"]+)"' page.html | sed 's/href="//;s/"//'

# Extract text from specific tags
grep -oP '<title>\K[^<]+' page.html

# Extract email addresses
grep -oP '[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}' page.html | sort -u
```

**Using Python for structured extraction (when available):**
```bash
python3 -c "
from html.parser import HTMLParser
import sys, json

class Extractor(HTMLParser):
    def __init__(self):
        super().__init__()
        self.results = []
        self.capture = False
        self.current = {}

    def handle_starttag(self, tag, attrs):
        attrs = dict(attrs)
        # Example: extract product cards
        if tag == 'div' and 'product' in attrs.get('class', ''):
            self.capture = True
            self.current = {}
        if self.capture and tag == 'a':
            self.current['link'] = attrs.get('href', '')

    def handle_data(self, data):
        if self.capture:
            data = data.strip()
            if data:
                self.current.setdefault('text', []).append(data)

    def handle_endtag(self, tag):
        if tag == 'div' and self.capture:
            self.capture = False
            if self.current:
                self.results.append(self.current)

parser = Extractor()
parser.feed(open('page.html').read())
print(json.dumps(parser.results, indent=2))
" > extracted.json
```

**Using xmllint for XHTML:**
```bash
# Extract with XPath (if page is valid XML/XHTML)
xmllint --html --xpath '//div[@class="item"]/text()' page.html 2>/dev/null
```

### Step 4: Handle pagination

**URL-parameter pagination:**
```bash
for page in $(seq 1 10); do
  curl -s \
    -H "User-Agent: $UA" \
    "https://example.com/listings?page=$page" >> all_pages.html
  sleep 1  # Rate limiting — always be polite
done
```

**Next-link pagination:**
```bash
url="https://example.com/page/1"
while [ -n "$url" ]; do
  curl -s -H "User-Agent: $UA" "$url" > current.html
  cat current.html >> all_pages.html

  # Extract next page URL
  url=$(grep -oP 'href="\K[^"]*(?=">Next)' current.html | head -1)
  [ -n "$url" ] && sleep 1
done
```

### Step 5: Normalize output

**HTML → JSON pipeline:**
```bash
# Extract table data to CSV
grep -oP '<tr>\K.*?(?=</tr>)' page.html | \
  sed 's/<td>/\n/g; s/<\/td>//g; s/<[^>]*>//g' | \
  awk 'NF' > data.csv

# Convert CSV to JSON
python3 -c "
import csv, json, sys
reader = csv.DictReader(open('data.csv'))
print(json.dumps(list(reader), indent=2))
" > data.json
```

**Data cleaning:**
- Strip HTML tags: `sed 's/<[^>]*>//g'`
- Normalize whitespace: `sed 's/  */ /g; s/^ //; s/ $//'`
- Decode HTML entities: `python3 -c "import html; print(html.unescape(input()))"`
- Remove empty lines: `awk 'NF'`

### Step 6: Rate limiting and ethics

**Rules:**
1. **Always check `robots.txt`** before scraping
2. **Rate limit:** Minimum 1 second between requests (use `sleep 1`)
3. **Set User-Agent** to identify your scraper
4. **Respect `Retry-After`** headers on 429 responses
5. **Cache responses** — don't re-fetch the same page unnecessarily
6. **Minimize load** — fetch only pages you need

**Retry with backoff:**
```bash
fetch_with_retry() {
  local url="$1" max_retries=3 delay=2
  for attempt in $(seq 1 $max_retries); do
    response=$(curl -s -w "\n%{http_code}" -H "User-Agent: $UA" "$url")
    code=$(echo "$response" | tail -1)
    body=$(echo "$response" | sed '$d')

    if [ "$code" -eq 200 ]; then
      echo "$body"
      return 0
    elif [ "$code" -eq 429 ]; then
      sleep $((delay * attempt))
    else
      return 1
    fi
  done
  return 1
}
```

## Success criteria
- Extracted data is structured (JSON/CSV) and validated
- No duplicate entries from pagination
- Rate limiting applied (no rapid-fire requests)
- robots.txt respected
- Output is clean (no HTML tags, normalized whitespace)
