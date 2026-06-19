# Sistema de Controle – LabTech

Sistema web (HTML + CSS + JS puro) com backend em Firebase Realtime Database.

## Estrutura

- `index.html` — página principal do sistema
- `sistema.html` — versão alternativa/anterior da página
- `app.js` — toda a lógica da aplicação e integração com Firebase
- `style.css` — estilos visuais

## Rodando localmente

Basta abrir o `index.html` no navegador, ou servir a pasta com qualquer servidor estático:

```bash
npx serve .
```

## ⚠️ Importante — Segurança do Firebase

As credenciais do Firebase (`apiKey`, `projectId` etc.) ficam visíveis em `app.js`.
Isso **não é uma falha de configuração que dá para corrigir escondendo a chave** —
toda aplicação Firebase client-side expõe essas chaves no navegador, mesmo ofuscadas.

A proteção real do banco de dados precisa vir das **Regras de Segurança** do Firebase
(Realtime Database / Authentication), exigindo login e checando permissões no
servidor. Antes de divulgar o link do GitHub Pages, confirme em:

> Firebase Console → Realtime Database → Regras

que o acesso de leitura/escrita exige autenticação e não está liberado como
`".read": true, ".write": true`.

## Deploy (GitHub Pages)

Este repositório está publicado em:
`https://SEU-USUARIO.github.io/NOME-DO-REPO/`
