FROM node:20-alpine

WORKDIR /app

COPY package*.json ./
RUN npm ci --omit=optional

COPY . .

ENV NODE_ENV=production
EXPOSE 8787

CMD ["npm", "run", "start"]
