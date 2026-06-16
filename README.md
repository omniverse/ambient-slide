# Ambient Slide

An interactive ambient audio mixer built with [Next.js](https://nextjs.org/).

## Getting Started

Install dependencies:

```bash
npm install
```

Start the development server:

```bash
npm run dev
```

Open [http://localhost:3000](http://localhost:3000) in your browser.

## Building for Production

```bash
npm run build
npm start
```

## Docker

```bash
docker build -t ambient-slide .
docker run -p 3000:3000 ambient-slide
```

## Styling

This project uses plain CSS (no Tailwind). Global styles live in `app/globals.css`.
