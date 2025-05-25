import puppeteer from 'puppeteer';
import fs from 'fs';
import dotenv from 'dotenv';
import OpenAI from 'openai';
import { createClient } from '@supabase/supabase-js';
import path from 'path';

dotenv.config({ path: './.env' });

const requiredEnv = [
  'OPENAI_API_KEY',
  'VITE_LINKEDIN_EMAIL',
  'VITE_LINKEDIN_PASSWORD',
  'VITE_SUPABASE_URL',
  'VITE_SUPABASE_SERVICE_ROLE_KEY'
].filter(key => !process.env[key]);

if (requiredEnv.length > 0) {
  console.error('❌ Missing required environment variables:', requiredEnv);
  process.exit(1);
}

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const supabase = createClient(
  process.env.VITE_SUPABASE_URL,
  process.env.VITE_SUPABASE_SERVICE_ROLE_KEY
);

let leads = [];
try {
  const data = fs.readFileSync('linkedin_profiles.json', 'utf-8');
  leads = JSON.parse(data);
} catch (error) {
  console.error('❌ Error reading linkedin_profiles.json:', error.message);
  process.exit(1);
}

async function autoLogin(page, retries = 2) {
  for (let attempt = 0; attempt < retries; attempt++) {
    try {
      await page.goto('https://www.linkedin.com/login', { waitUntil: 'networkidle2', timeout: 25000 });
      await page.waitForSelector('#username', { timeout: 25000 });
      await page.type('#username', process.env.VITE_LINKEDIN_EMAIL, { delay: 150 });
      await page.type('#password', process.env.VITE_LINKEDIN_PASSWORD, { delay: 150 });
      await Promise.all([
        page.click('button[type="submit"]'),
        page.waitForNavigation({ waitUntil: 'networkidle0', timeout: 25000 })
      ]);
      console.log('✅ Logged in successfully to LinkedIn.');
      return;
    } catch (error) {
      console.error(`❌ Login attempt ${attempt + 1} failed:`, error.message);
      if (attempt === retries - 1) throw error;
      await new Promise(r => setTimeout(r, 5000));
    }
  }
}

async function scoreLead(bio) {
  if (!bio || bio.length < 80 || bio === 'Bio not found') {
    return { angelScore: 1, icpScore: 1, finalScore: 1 };
  }

  try {
    const response = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [
        { role: 'system', content: 'Return JSON with angelScore and icpScore (0-10) based on the bio.' },
        { role: 'user', content: bio }
      ],
      temperature: 0.7,
      max_tokens: 100
    });

    const content = response.choices[0].message.content || '{}';
    const json = JSON.parse(content.match(/\{[\s\S]*\}/)?.[0] || '{}');
    const angelScore = Math.min(Math.max(Number(json.angelScore) || 1, 0), 10);
    const icpScore = Math.min(Math.max(Number(json.icpScore) || 1, 0), 10);
    const finalScore = (angelScore + icpScore) / 2;

    return { angelScore, icpScore, finalScore };
  } catch (err) {
    console.error('❌ GPT Score error:', err.message);
    return { angelScore: 1, icpScore: 1, finalScore: 1 };
  }
}

async function generateConnectionMessage(bio, name, angelScore) {
  try {
    const response = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [
        { role: 'system', content: 'Generate a concise LinkedIn message (max 300 chars). Mention name, bio, angelScore and investment.' },
        { role: 'user', content: `Name: ${name}, Bio: ${bio}, AngelScore: ${angelScore}` }
      ],
      temperature: 0.5,
      max_tokens: 100
    });

    return response.choices[0].message.content.trim().slice(0, 300);
  } catch {
    return `Hi ${name}, I’m with LinkWise (Superland). Let's connect to explore investment opportunities!`;
  }
}

async function scrapeProfile(url, page) {
  try {
    await page.goto(url, { waitUntil: 'networkidle2', timeout: 25000 });
    await page.waitForSelector('.text-heading-xlarge', { timeout: 25000 });

    const name = await page.$eval('.text-heading-xlarge', el => el.textContent.trim()).catch(() => 'Name not found');
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
    await new Promise(res => setTimeout(res, 6000));

    const bio = await page.$eval('div[data-section="about"] .pv-about__summary-text', el => el.textContent.trim())
      .catch(() => page.evaluate(() => {
        const el = document.querySelector('[data-section="about"], section[id*="about"]');
        return el ? el.innerText.trim() : 'Bio not found';
      }))
      .catch(() => 'Bio not found');

    return { name, bio };
  } catch (err) {
    console.error(`❌ Error scraping ${url}:`, err.message);
    return { name: 'Error', bio: 'Bio not found' };
  }
}

async function sendConnectionRequest(page, url, name, bio, angelScore) {
  try {
    await page.goto(url, { waitUntil: 'networkidle2', timeout: 25000 });

    const connect = await page.$('button[aria-label*="Invite"]');
    if (!connect) {
      console.warn(`⚠️ No connect button for ${name}`);
      return;
    }

    await connect.click();

    const addNoteBtn = await page.waitForSelector('button[aria-label="Add a note"]', { timeout: 10000 }).catch(() => null);
    let message = '';
    if (addNoteBtn) {
      await addNoteBtn.click();
      message = await generateConnectionMessage(bio, name, angelScore);
      await page.type('#connect-cta-form__invitation', message, { delay: 50 });
    }

    const sendBtn = await page.waitForSelector('button[aria-label="Send now"]', { timeout: 10000 }).catch(() => null);
    if (sendBtn) {
      await sendBtn.click();
      console.log(`🤝 Sent invite to ${name}: ${message}`);
    } else {
      console.warn(`⚠️ No send button for ${name}`);
    }
  } catch (err) {
    console.warn(`⚠️ Connection error for ${name}: ${err.message}`);
  }
}

async function main() {
  const browser = await puppeteer.launch({
    headless: process.env.SHOW_BROWSER ? false : 'new',
    defaultViewport: null,
    slowMo: 50,
    args: ['--start-maximized', '--disable-notifications']
  });

  const page = await browser.newPage();
  await autoLogin(page).catch(() => process.exit(1));

  const results = [];

  for (const lead of leads) {
    const { name, bio } = await scrapeProfile(lead.url, page);
    const scores = await scoreLead(bio);

    const leadData = {
      name,
      bio,
      url: lead.url,
      email: `${name.toLowerCase().replace(/\s+/g, '.')}@mockmail.com`,
      angelScore: scores.angelScore,
      icpScore: scores.icpScore,
      finalScore: scores.finalScore,
      platform: 'LinkedIn',
      tags: 'auto',
      meeting_scheduled: false,
      meeting_time: null
    };

    const { error } = await supabase.from('leads').insert(leadData).catch(err => {
      console.warn(`⚠️ Supabase insert failed for ${name}:`, err.message);
      return { error: err };
    });

    if (!error) console.log(`✅ Inserted ${name} into Supabase`);

    if (scores.angelScore >= 7) {
      await sendConnectionRequest(page, lead.url, name, bio, scores.angelScore);
    } else {
      console.log(`⛔️ Skipped ${name} (angelScore: ${scores.angelScore})`);
    }

    results.push(leadData);
  }

  const outDir = path.join('public');
  if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(outDir, 'leads_output.json'), JSON.stringify(results, null, 2));

  await browser.close();
  console.log(`✅ Done. ${results.length} profiles processed.`);
}

main().catch(err => {
  console.error('❌ Main process failed:', err.message);
  process.exit(1);
});