import express from 'express';
import multer from 'multer';
import fs from 'fs';
import path from 'path';
import { exec } from 'child_process';
import open from 'open';

const app = express();
const port = 3000;

const __dirname = path.resolve();
const upload = multer({ dest: path.join(__dirname, 'uploads') });

app.use(express.static(path.join(__dirname, 'public')));

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

app.post('/upload', upload.single('profiles'), (req, res) => {
  const tempPath = req.file.path;
  const targetPath = path.join(__dirname, 'linkedin_profiles.json');

  fs.copyFile(tempPath, targetPath, (copyErr) => {
    if (copyErr) {
      console.error("❌ Erro ao copiar arquivo:", copyErr);
      return res.status(500).send("Erro ao copiar arquivo.");
    }

    fs.unlink(tempPath, (unlinkErr) => {
      if (unlinkErr) {
        console.warn("⚠️ Erro ao remover temporário:", unlinkErr);
      }

      console.log("✅ Arquivo recebido. Executando análise com scrape.js...");
      exec('node scrape.js', (error, stdout, stderr) => {
        if (error) {
          console.error("❌ Erro no scrape.js:", error.message);
          return res.status(500).send(`<h2>❌ Erro ao executar a análise.</h2><pre>${error.message}</pre>`);
        }

        console.log(stdout);
        res.send(`<h1>✅ Perfis analisados com sucesso!</h1><pre>${stdout}</pre><a href="/">Voltar</a>`);
      });
    });
  });
});

app.listen(port, async () => {
  const url = `http://localhost:${port}`;
  console.log(`🚀 Servidor rodando: ${url}`);
  await open(url); // Abrir navegador automaticamente
});
