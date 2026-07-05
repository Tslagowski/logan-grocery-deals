import OpenAI from 'openai';
import { Resend } from 'resend';
import { chromium } from 'playwright';

const openaiModel = process.env.OPENAI_MODEL ?? 'gpt-4.1-mini';
const sourceFetchConcurrency = 3;

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

const resend = new Resend(process.env.RESEND_API_KEY);

const dealSources = [
  {
    storeName: "Smith's Weekly Ad",
    url: 'https://www.smithsfoodanddrug.com/weeklyad',
  },
  {
    storeName: "Smith's Weekly Digital Deals",
    url: 'https://www.smithsfoodanddrug.com/pr/weekly-digital-deals',
  },
  {
    storeName: "Macey's Weekly Ad",
    url: 'https://shop.maceys.com/store/maceys/flyers/weekly',
  },
  {
    storeName: "Macey's Storefront Weekly Ad",
    url: 'https://shop.maceys.com/store/maceys/storefront',
  },
  {
    storeName: "Lee's Marketplace Storefront",
    url: 'https://shop.leesmarketplace.com/store/lees-marketplace/storefront',
  },
  {
    storeName: "Lee's Marketplace Ad",
    url: 'https://ad.leesmarketplace.com/',
  },
  {
    storeName: "Ridley's RPerks Weekly Ad",
    url: 'https://rperks.shopridleys.com/interactive-weekly-ad',
  },
  {
    storeName: 'Costco Warehouse Savings',
    url: 'https://www.costco.com/warehouse-savings.html',
  },
  {
    storeName: 'Walmart Logan',
    url: 'https://www.walmart.com/store/1888-logan-ut',
  },
];

function formatDateForReport() {
  return new Date().toLocaleDateString('en-US', {
    timeZone: 'America/Denver',
    weekday: 'long',
    year: 'numeric',
    month: 'long',
    day: 'numeric',
  });
}

function assertRequiredEnvironmentVariables() {
  const requiredEnvironmentVariables = [
    'OPENAI_API_KEY',
    'RESEND_API_KEY',
    'DEAL_REPORT_TO_EMAIL',
  ];

  const missingEnvironmentVariables = requiredEnvironmentVariables.filter(
    (environmentVariableName) => !process.env[environmentVariableName]
  );

  if (missingEnvironmentVariables.length > 0) {
    throw new Error(
      `Missing environment variables: ${missingEnvironmentVariables.join(', ')}`
    );
  }
}

function looksLikeWeeklyAdText(text) {
  const normalizedText = text.toLowerCase();
  const hasPrices = /\$\d|save\s+\$|\d+\s*\/\s*\$\d|\bbuy\b.*\bget\b/i.test(text);
  const hasDealWords = [
    'weekly ad',
    'digital deal',
    'coupon',
    'sale',
    'save',
    'price',
    'lb',
  ].some((word) => normalizedText.includes(word));

  return hasPrices && hasDealWords;
}

function compactText(text, maxLength = 18000) {
  return text
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, maxLength);
}

async function fetchDealSource(source, browser) {
  const page = await browser.newPage();
  const startedAt = Date.now();

  try {
    await page.setExtraHTTPHeaders({
      'accept-language': 'en-US,en;q=0.9',
    });

    await page.goto(source.url, {
      waitUntil: 'domcontentloaded',
      timeout: 45000,
    });

    await page.waitForTimeout(5000);

    for (let scrollIndex = 0; scrollIndex < 4; scrollIndex += 1) {
      await page.mouse.wheel(0, 1600);
      await page.waitForTimeout(750);
    }

    const pageText = await page.locator('body').innerText({ timeout: 10000 });
    const metadata = await page.evaluate(() => {
      const metaDescription =
        document
          .querySelector('meta[name="description"], meta[property="og:description"]')
          ?.getAttribute('content') ?? '';
      const links = Array.from(document.querySelectorAll('a[href]'))
        .map((link) => `${link.textContent?.trim() ?? ''} ${link.href}`.trim())
        .filter(Boolean)
        .slice(0, 80);
      const images = Array.from(document.querySelectorAll('img'))
        .map((image) => image.alt || image.getAttribute('aria-label') || '')
        .filter(Boolean)
        .slice(0, 80);

      return { title: document.title, metaDescription, links, images };
    });

    const combinedText = compactText(
      [
        `Title: ${metadata.title}`,
        `Description: ${metadata.metaDescription}`,
        pageText,
        metadata.links.length > 0 ? `Links: ${metadata.links.join(' | ')}` : '',
        metadata.images.length > 0 ? `Image labels: ${metadata.images.join(' | ')}` : '',
      ].join('\n')
    );

    return {
      ...source,
      ok: true,
      status: 'loaded',
      characterCount: combinedText.length,
      elapsedMs: Date.now() - startedAt,
      realWeeklyAdContent: looksLikeWeeklyAdText(combinedText),
      text: combinedText,
    };
  } catch (error) {
    return {
      ...source,
      ok: false,
      status: 'load error',
      characterCount: 0,
      elapsedMs: Date.now() - startedAt,
      realWeeklyAdContent: false,
      text: '',
      error: error.message,
    };
  } finally {
    await page.close();
  }
}

async function mapWithConcurrency(items, concurrency, mapper) {
  const results = new Array(items.length);
  let nextIndex = 0;

  async function worker() {
    while (nextIndex < items.length) {
      const currentIndex = nextIndex;
      nextIndex += 1;
      results[currentIndex] = await mapper(items[currentIndex], currentIndex);
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(concurrency, items.length) }, () => worker())
  );

  return results;
}

function buildSourceDiagnostics(sourceResults) {
  return sourceResults.map((sourceResult) => ({
    storeName: sourceResult.storeName,
    url: sourceResult.url,
    status: sourceResult.status,
    characterCount: sourceResult.characterCount,
    elapsedMs: sourceResult.elapsedMs,
    realWeeklyAdContent: sourceResult.realWeeklyAdContent,
    error: sourceResult.error,
    preview: sourceResult.text.slice(0, 1000),
  }));
}

async function createReportWithWebSearch(sourceResults) {
  const today = formatDateForReport();
  const sourceDiagnostics = buildSourceDiagnostics(sourceResults);

  return openai.responses.create({
    model: openaiModel,
    tools: [
      {
        type: 'web_search',
        search_context_size: 'medium',
        user_location: {
          type: 'approximate',
          country: 'US',
          region: 'Utah',
          city: 'Logan',
        },
      },
    ],
    tool_choice: 'required',
    input: [
      {
        role: 'system',
        content: `
You create concise grocery deal reports for Logan, Utah.

Only include specific item-level deals when actual item prices are present.
Do not invent prices.
Use web search to verify current public deals from official store pages, weekly ads, flyers, and public store pages.
Prefer Logan, Utah stores and nearby Cache Valley stores.
If a deal is not clearly current, mark the expiration as "verify in ad" instead of guessing.
Include a source URL for each deal in the Reason column.

Prioritize:
- chicken, lean beef, turkey, pork, fish, shrimp
- eggs, Greek yogurt, cottage cheese
- protein shakes and bars
- fruits, vegetables
- low-calorie sauces and zero-calorie drinks
- household essentials

Required report format:

# Logan Grocery Deals

Date checked: ${today}

## Specific Deals Found
Use a markdown table:
Item | Store | Price/Discount | Expiration | Recommendation | Reason

## Stores With No Usable Item Prices
List each target store where neither the direct fetch nor web search found usable item-level prices.

## Debug Source Diagnostics
Use the supplied diagnostics. Include Store, URL, Status, Character Count, Real Weekly Ad Content, and Error if present.
`,
      },
      {
        role: 'user',
        content: JSON.stringify(
          {
            targetStores: dealSources.map((source) => source.storeName),
            sourceDiagnostics,
            directFetchText: sourceResults.map((sourceResult) => ({
              storeName: sourceResult.storeName,
              url: sourceResult.url,
              text: sourceResult.text,
            })),
          },
          null,
          2
        ),
      },
    ],
  });
}

async function createReportWithoutWebSearch(sourceResults) {
  const today = formatDateForReport();
  const sourceDiagnostics = buildSourceDiagnostics(sourceResults);

  return openai.responses.create({
    model: openaiModel,
    input: [
      {
        role: 'system',
        content: `
You create concise grocery deal reports for Logan, Utah.

Only include specific item-level deals when actual item prices are present in the supplied source text.
Do not invent prices.

Required report format:

# Logan Grocery Deals

Date checked: ${today}

## Specific Deals Found
Use a markdown table:
Item | Store | Price/Discount | Expiration | Recommendation | Reason

## Stores With No Usable Item Prices
List each target store where the direct fetch did not contain usable item-level prices.

## Debug Source Diagnostics
Use the supplied diagnostics. Include Store, URL, Status, Character Count, Real Weekly Ad Content, and Error if present.

Add this note at the top of Debug Source Diagnostics:
OpenAI web search fallback was unavailable for this run, so this report only used direct page fetches.
`,
      },
      {
        role: 'user',
        content: JSON.stringify(
          {
            targetStores: dealSources.map((source) => source.storeName),
            sourceDiagnostics,
            directFetchText: sourceResults.map((sourceResult) => ({
              storeName: sourceResult.storeName,
              url: sourceResult.url,
              text: sourceResult.text,
            })),
          },
          null,
          2
        ),
      },
    ],
  });
}

async function buildReport(sourceResults) {
  try {
    const response = await createReportWithWebSearch(sourceResults);
    return response.output_text;
  } catch (error) {
    console.warn(`OpenAI web search report failed; retrying without web search: ${error.message}`);
    const response = await createReportWithoutWebSearch(sourceResults);
    return response.output_text;
  }
}

async function fetchAllDealSources(browser) {
  return mapWithConcurrency(
    dealSources,
    sourceFetchConcurrency,
    async (source) => {
      const result = await fetchDealSource(source, browser);
      console.log(
        `${result.storeName}: ${result.status}, ${result.characterCount} chars, weekly ad=${result.realWeeklyAdContent}`
      );
      return result;
    }
  );
}


function buildEmailHtml(report) {
  const escapedReport = report
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;');

  return `
<!doctype html>
<html>
  <body style="font-family: Arial, sans-serif; line-height: 1.5;">
    <h2>Logan Grocery Deals</h2>
    <pre style="white-space: pre-wrap; font-family: Arial, sans-serif;">${escapedReport}</pre>
  </body>
</html>
`;
}

async function sendEmail(report) {
  const today = new Date().toLocaleDateString('en-US', {
    timeZone: 'America/Denver',
    weekday: 'short',
    month: 'short',
    day: 'numeric',
  });

  const { error } = await resend.emails.send({
    from: 'Grocery Deals <onboarding@resend.dev>',
    to: process.env.DEAL_REPORT_TO_EMAIL,
    subject: `Logan Grocery Deals - ${today}`,
    text: report,
    html: buildEmailHtml(report),
  });

  if (error) {
    throw new Error(`Resend failed to send email: ${JSON.stringify(error)}`);
  }
}

async function main() {
  assertRequiredEnvironmentVariables();

  const browser = await chromium.launch({
    headless: true,
  });

  try {
    const sourceResults = await fetchAllDealSources(browser);

    const report = await buildReport(sourceResults);

    await sendEmail(report);
  } finally {
    await browser.close();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
