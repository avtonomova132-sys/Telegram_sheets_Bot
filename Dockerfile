FROM node:18-slim

# python3 + Pillow/numpy для verse/generate_verse_image.py, fonts-liberation —
# источник шрифтов по пути /usr/share/fonts/truetype/liberation/, зашитому в скрипте.
RUN apt-get update \
    && apt-get install -y --no-install-recommends python3 python3-pip fonts-liberation \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY requirements.txt ./
RUN pip3 install --no-cache-dir --break-system-packages -r requirements.txt

COPY package.json ./
RUN npm install --omit=dev

COPY . .

CMD ["node", "index.js"]
