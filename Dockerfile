FROM node:22-alpine

WORKDIR /app

COPY package*.json ./
RUN npm ci --omit=dev

COPY . .

# 3001 = API + government console, 8000 = rights-holder portal, 3002 = licensee portal
EXPOSE 3001 8000 3002

CMD ["node", "start-all.js"]
