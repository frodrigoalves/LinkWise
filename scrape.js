import puppeteer from 'puppeteer';
import fs from 'fs';
import dotenv from 'dotenv';
import OpenAI from 'openai';
import { createClient } from '@supabase/supabase-js';

dotenv.config({ path: './.env' });

// Fallback caso .env falhe
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

async function autoLogin(page) {
  try {
    await page.goto('https://www.linkedin.com/login', { waitUntil: 'networkidle2', timeout: 20000 });
    await page.waitForSelector('#username', { timeout: 20000 });
    await page.type('#username', process.env.VITE_LINKEDIN_EMAIL, { delay: 150 });
    await page.type('#password', process.env.VITE_LINKEDIN_PASSWORD, { delay: 150 });
    await Promise.all([
      page.click('button[type="submit"]'),
      page.waitForNavigation({ waitUntil: 'networkidle0', timeout: 20000 })
    ]);
    console.log('✅ Logged in successfully to LinkedIn.');
  } catch (error) {
    console.error('❌ Login failed:', error.message);
    throw error;
  }
}

async function scoreLead(bio) {
  console.log(`📝 Bio for scoring: "${bio}"`);
  if (!bio || bio.length < 80 || bio === 'Bio not found') {
    console.log('⚠️ Bio too short or not found, assigning default scores');
    return { angelScore: 1, icpScore: 1, finalScore: 1 };
  }

  try {
    const response = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [
        { role: 'system', content: 'You are an expert in startup evaluation. Return only JSON with "angelScore" and "icpScore" from 0 to 10 based on the bio.' },
        { role: 'user', content: bio }
      ],
      temperature: 0.7,
      max_tokens: 100
    });

    const content = response.choices[0].message.content || '{}';
    const match = content.match(/\{[\s\S]*\}/);
    const jsonString = match ? match[0] : '{}';
    const { angelScore, icpScore } = JSON.parse(jsonString);

    const scores = {
      angelScore: Math.min(Math.max(parseFloat(angelScore) || 1, 0), 10),
      icpScore: Math.min(Math.max(parseFloat(icpScore) || 1, 0), 10),
      finalScore: ((Math.min(Math.max(parseFloat(angelScore) || 1, 0), 10) + Math.min(Math.max(parseFloat(icpScore) || 1, 0), 10)) / 2)
    };
    console.log(`📈 Scores: ${JSON.stringify(scores)}`);
    return scores;
  } catch (error) {
    console.error('❌ Failed to score profile:', error.message);
    return { angelScore: 1, icpScore: 1, finalScore: 1 };
  }
}

async function generateConnectionMessage(bio, name, angelScore) {
  try {
    const response = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [
        { role: 'system', content: 'Generate a concise LinkedIn connection request (max 300 characters) for a startup founder using LinkWise (Superland). Personalize with name, bio, and angelScore (0-10). Highlight investment opportunities, keep tone enthusiastic yet respectful.' },
        { role: 'user', content: `Name: ${name}, Bio: ${bio}, AngelScore: ${angelScore}` }
      ],
      temperature: 0.5,
      max_tokens: 100
    });

    return response.choices[0].message.content.trim().slice(0, 300);
  } catch (error) {
    console.error('❌ Failed to generate message:', error.message);
    return `Hi ${name}, I’m with LinkWise (Superland) and admire your expertise. Let’s connect to explore investment opportunities!`;
  }
}

async function scrapeProfile(url, page) {
  try {
    console.log(`🌐 Loading profile: ${url}`);
    await page.goto(url, { waitUntil: 'networkidle2', timeout: 20000 });

    await page.waitForSelector('.text-heading-xlarge', { timeout: 20000 });
    const name = await page.$eval('.text-heading-xlarge', el => el.textContent.trim()).catch(() => 'Name not found');

    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
    await new Promise(resolve => setTimeout(resolve, 6000));

    const bio = await page.$eval('div[data-section="about"] .pv-about__summary-text', el => el.textContent.trim())
      .catch(() => page.$eval('section.pv-about-section .pv-about__summary-text', el => el.textContent.trim()))
      .catch(() => page.$eval('.pv-profile-section__section-info--text', el => el.textContent.trim()))
      .catch(() => page.evaluate(() => {
        const aboutSection = document.querySelector('section[id*="about"]');
        return aboutSection ? aboutSection.textContent.trim() : 'Bio not found';
      }))
      .catch(() => 'Bio not found');

    return { name: name.replace(/\s+/g, ' ').trim(), bio: bio.replace(/\s+/g, ' ').trim() };
  } catch (error) {
    console.error(`❌ Error loading profile ${url}:`, error.message);
    return { name: 'Error', bio: 'Bio not found' };
  }
}

async function sendConnectionRequest(page, url, name, bio, angelScore) {
  try {
    await page.goto(url, { waitUntil: 'networkidle2', timeout: 20000 });

    const connectBtn = await page.$('button[aria-label*="Invite"]');
    if (connectBtn) {
      await connectBtn.click();

      const addNoteBtn = await page.waitForSelector('button[aria-label="Add a note"]', { timeout: 12000 }).catch(() => null);
      if (addNoteBtn) {
        await addNoteBtn.click();
        const message = await generateConnectionMessage(bio, name, angelScore);
        await page.type('#connect-cta-form__invitation', message, { delay: 50 });
      }

      const sendBtn = await page.waitForSelector('button[aria-label="Send now"]', { timeout: 12000 }).catch(() => null);
      if (sendBtn) {
        await sendBtn.click();
        console.log(`🤝 Connection request sent to ${name}: ${message}`);
      } else {
        console.log(`⚠️ Cannot send invite to ${name}`);
      }
    } else {
      console.log(`⚠️ No connect button found for ${name}`);
    }

    await new Promise(r => setTimeout(r, 6000));
  } catch (error) {
    console.error(`❌ Error connecting to ${name}:`, error.message);
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
    const score = await scoreLead(bio);

    const leadData = {
      name,
      bio,
      url: lead.url,
      platform: 'LinkedIn',
      email: `${name.toLowerCase().replace(/\s+/g, '.')}@mockemail.com`,
      angelScore: score.angelScore,
      icpScore: score.icpScore,
      finalScore: score.finalScore,
      tags: 'auto',
      meeting_scheduled: false,
      meeting_time: null
    };

    console.log(`📊 ${name} – Angel: ${score.angelScore} | ICP: ${score.icpScore}`);

    const { error } = await supabase.from('leads').insert(leadData).catch(err => {
      console.error(`❌ Failed to insert ${name} into Supabase:`, err.message);
      return { error: err };
    });
    if (!error) console.log(`✅ Successfully inserted ${name} into Supabase`);

    results.push(leadData);

    if (score.angelScore >= 7) await sendConnectionRequest(page, lead.url, name, bio, score.angelScore);
    else console.log(`⛔️ Skipped ${name}, angelScore too low (${score.angelScore})`);
  }

  fs.writeFileSync('public/leads_output.json', JSON.stringify(results, null, 2));
  await browser.close();
  console.log('✅ All profiles processed.');
}

main().catch(err => {
  console.error('❌ Main process failed:', err.message);
  process.exit(1);
});