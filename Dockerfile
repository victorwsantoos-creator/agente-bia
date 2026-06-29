FROM node:20-alpine
WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev
COPY . .
RUN find . -name "*evolu*" ! -name "evolution.js" -exec mv {} evolution.js \; 2>/dev/null || true
EXPOSE 3000
CMD ["node", "index.js"]
