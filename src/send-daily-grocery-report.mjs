import OpenAI from 'openai';
import { Resend } from 'resend';

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

async function fetchDealSourceText(source) {
  try {
    const response = await fetch(source.url, {
      headers: {
        'user-agent': 'Mozilla/5.0 grocery-deal-checker',
      },
    });

    if (!response.ok) {
      return `${source.storeName}: Unable to fetch ${source.url}. Status ${response.status}`;
    }

    const html = await response.text();

    return `
STORE: ${source.storeName}
URL: ${source.url}
RAW_PAGE_TEXT:
${html.slice(0, 12000)}
`;
  } catch (error) {
    return `${source.storeName}: Unable to fetch ${source.url}. Error: ${error.message}`;
  }
}

async function buildReport(sourceTexts) {
  const response = await openai.responses.create({
    model: 'gpt-4.1-mini',
    input: [
      {
        role: 'system',
        content: `
You create concise grocery deal reports for Logan, Utah.

Only include specific item-level deals.
Do not include generic store summaries.
Prioritize weight-lifting nutrition:
- chicken, lean beef, turkey, pork, fish, shrimp
- eggs, Greek yogurt, cottage cheese
- protein shakes and bars only when legitimately discounted
- fruits, vegetables
- low-calorie sauces and zero-calorie drinks
- household essentials

For each deal include:
Item | Store | Price/Discount | Expiration if known | Buy/Skip/Stock-up | Reason

If the source text does not contain specific item-level pricing, say that specific item-level deals were unavailable for that store.
Do not invent prices.
`,
      },
      {
        role: 'user',
        content: sourceTexts.join('\n\n'),
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

  const sourceTexts = await Promise.all(
    dealSources.map((source) => fetchDealSourceText(source))
  );

  const report = await buildReport(sourceTexts);

  await sendEmail(report);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});