FROM node:20-alpine
WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev
COPY . .
RUN mv "evolu\303\247\303\243o.js" evolution.js 2>/dev/null || mv evolucao.js evolution.js 2>/dev/null || true
EXPOSE 3000
CMD ["node", "index.js"]
