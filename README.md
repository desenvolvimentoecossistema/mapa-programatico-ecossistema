# Mapa de Atuação Programático

Consulta dos programas e das estratégias das organizações do Ecossistema.

## Execução

Requer Node.js 24.13 ou posterior da série 24 e disco persistente.
Copie `.env.example` para `.env` e preencha os valores do servidor.

```
npm run build
npm start
```

O arquivo indicado por `DATABASE_PATH` pertence a esta aplicação. Faça backups
desse arquivo com a aplicação parada ou pela API de backup do SQLite. O banco
deve ficar fora da pasta pública e ser preservado em cada implantação.
Esta configuração utiliza uma instância de cada aplicação. Para várias réplicas,
é necessário adaptar o armazenamento a um banco compartilhado antes de escalar.

## Configuração dos dois endereços

Use os domínios HTTPS definitivos em `SITE_ORIGIN` (agenda) e `MAP_ORIGIN` (mapa).
Em cada aplicação, `SSO_PEER_ORIGIN` recebe a origem HTTPS exata da outra.
Configure o mesmo `SSO_SHARED_SECRET` aleatório, de pelo menos 32 caracteres,
nos dois servidores e mantenha `SSO_AUTO_LOGIN=true`.

No cliente Web do Google, cadastre as duas URIs de retorno:
`https://DOMINIO-DA-AGENDA/auth/callback/google` e
`https://DOMINIO-DO-MAPA/auth/callback/google`.
Cadastre também os domínios finais nas configurações do aplicativo Google.
Configure as credenciais diretamente no servidor; nunca as publique no repositório.
Os domínios de e-mail permitidos estão em `AUTH_ALLOWED_DOMAINS`; os administradores
são definidos separadamente em cada aplicação.

O acesso entre os sites ocorre diretamente pelos dois endereços configurados.
Nenhum servidor de desenvolvimento é necessário para a execução.

## Dados existentes

O pacote inclui estrutura e código, sem sessões, senhas ou cópia do banco de produção.
O mapa inclui os programas de referência. A fonte oficial é indicada por GOOGLE_SHEETS_ID; a chave de leitura fica em GOOGLE_SHEETS_SERVICE_ACCOUNT. Compartilhe apenas essa planilha com a conta de serviço, como leitora. No mapa, Atualizar do Google Sheets abre uma prévia e Publicar atualização confirma os dados.
