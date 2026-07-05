import OpenAI from 'openai';
import { Resend } from 'resend';
import { chromium } from 'playwright';

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

const resend = new Resend(process.env.RESEND_API_KEY);

const dealSources = [
  {
    storeName: "Smith's",
    url: 'https://www.smithsfoodanddrug.com/weeklyad',
  },
  {
    storeName: "Macey's",
    url: 'https://www.maceys.com/weekly-ad',
  },
  {
    storeName: "Lee's Marketplace",
    url: 'https://www.leesmarketplace.com/weekly-ad',
  },
  {
    storeName: "Ridley's Family Market",
    url: 'https://shopridleys.com/weekly-ad',
  },
  {
    storeName: 'Costco',
    url: 'https://www.costco.com/warehouse-savings.html',
  },
  {
    storeName: 'Walmart Logan',
    url: 'https://www.walmart.com/store/1888-logan-ut',
  },
];

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

async function fetchDealSourceText(source, browser) {
  const page = await browser.newPage();

  try {
    await page.goto(source.url, {
      waitUntil: 'networkidle',
      timeout: 60000,
    });

    const pageText = await page.locator('body').innerText({
      timeout: 30000,
    });

    return `
STORE: ${source.storeName}
URL: ${source.url}
PAGE_TEXT:
${pageText.slice(0, 20000)}
`;
  } catch (error) {
    return `${source.storeName}: Unable to load ${source.url}. Error: ${error.message}`;
  } finally {
    await page.close();
  }
}

async function buildReport(sourceTexts) {
  const sourceDiagnostics = sourceTexts
    .map((sourceText) => {
      const storeMatch = sourceText.match(/STORE:\s*(.*)/);
      const urlMatch = sourceText.match(/URL:\s*(.*)/);

      return {
        storeName: storeMatch?.[1] ?? 'Unknown store',
        url: urlMatch?.[1] ?? 'Unknown URL',
        characterCount: sourceText.length,
        preview: sourceText.slice(0, 1200),
      };
    });

  const response = await openai.responses.create({
    model: 'gpt-4.1-mini',
    input: [
      {
        role: 'system',
        content: `
You create concise grocery deal reports for Logan, Utah.

Only include specific item-level deals when actual item prices are present.
Do not invent prices.

Prioritize:
- chicken, lean beef, turkey, pork, fish, shrimp
- eggs, Greek yogurt, cottage cheese
- protein shakes and bars
- fruits, vegetables
- low-calorie sauces and zero-calorie drinks
- household essentials

Required report format:

# Logan Grocery Deals

## Specific Deals Found
Use a markdown table:
Item | Store | Price/Discount | Expiration | Recommendation | Reason

## Stores With No Usable Item Prices
List each store where the page loaded but no item-level prices were visible.

## Debug Source Diagnostics
For each source, include:
- Store
- URL
- Character count
- Whether page text looked like real weekly ad content or just a site shell
`,
      },
      {
        role: 'user',
        content: JSON.stringify(
          {
            sourceDiagnostics,
            fullSourceTexts: sourceTexts,
          },
          null,
          2
        ),
      },
    ],
  });

  return response.output_text;
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
    const sourceTexts = await Promise.all(
      dealSources.map((source) => fetchDealSourceText(source, browser))
    );

    const report = await buildReport(sourceTexts);

    await sendEmail(report);
  } finally {
    await browser.close();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});