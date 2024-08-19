FROM node:22-alpine

ARG PORT=3000
VOLUME [ "/app/data" ]

WORKDIR /app

COPY . /app

RUN npm install
RUN npm run build
RUN npm prune --production

EXPOSE 8000

CMD ["npm","run", "start"]
