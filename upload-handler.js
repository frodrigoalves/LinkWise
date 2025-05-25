import express from 'express';
import multer from 'multer';
import fs from 'fs';
import path from 'path';
import { exec } from 'child_process';
import { createClient } from '@supabase/supabase-js';
import dotenv from 'dotenv';

dotenv.config();

const app = express();
const port = process.env.PORT || 3000;

const supabase = createClient(
  process.env.VITE_SUPABASE_URL,
  process.env.VITE_SUPABASE_SERVICE_ROLE_KEY
);

const __dirname = path.resolve();
const uploadDir = path.join(__dirname, 'uploads');
const leadsOutputPath = path.join(__dirname, 'public', 'leads_output.json');

if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir, { recursive: true });

const upload = multer({ dest: uploadDir });

app.use(express.static(path.join(__dirname, 'public')));

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'src', 'index.html'));
});

app.get('/leads_output.json', (req, res) => {
  if (fs.existsSync(leadsOutputPath)) {
    res.sendFile(leadsOutputPath);
  } else {
    res.status(404).send('Leads output not found.');
  }
});

app.post('/upload', upload.single('profiles'), async (req, res) => {
  if (!req.file) return res.status(400).send('Nenhum arquivo enviado.');

  const tempPath = req.file.path;
  const targetPath = path.join(__dirname, 'linkedin_profiles.json');

  try {
    fs.copyFileSync(tempPath, targetPath);
    fs.unlinkSync(tempPath);
    console.log('✅ Arquivo linkedin_profiles.json atualizado.');

    const scriptPath = path.join(__dirname, 'src', 'scrape.js');
    exec('npx puppeteer browsers install chrome', (installError) => {
      if (installError) {
        console.error('❌ Erro ao instalar Chrome:', installError.message);
        return res.status(500).send(`<h2>❌ Erro ao instalar Chrome</h2><pre>${installError.message}</pre>`);
      }
      exec(`SHOW_BROWSER=true node ${scriptPath}`, async (error, stdout, stderr) => {
        if (error) {
          console.error('❌ Erro no scraper:', error.message);
          return res.status(500).send(`<h2>❌ Erro ao executar a análise.</h2><pre>${error.message}</pre>`);
        }

        console.log(stdout);

        if (fs.existsSync(leadsOutputPath)) {
          const data = JSON.parse(fs.readFileSync(leadsOutputPath, 'utf-8'));
          const { error: insertError } = await supabase.from('leads').insert(data);
          if (insertError) {
            console.error('❌ Erro ao inserir no Supabase:', insertError.message);
            return res.status(500).send(`<h2>❌ Erro ao inserir no Supabase</h2><pre>${insertError.message}</pre>`);
          }
          console.log('✅ Leads inseridos com sucesso no Supabase.');
        }

        res.send(`<h1>✅ Perfis analisados com sucesso!</h1><pre>${stdout}</pre><a href="/">Voltar</a>`);
      });
    });
  } catch (err) {
    console.error('❌ Erro geral no upload:', err.message);
    res.status(500).send(`<h2>❌ Erro no upload</h2><pre>${err.message}</pre>`);
  }
});

app.listen(port, '0.0.0.0', () => {
  console.log(`🚀 Servidor ativo na porta ${port}`);
});