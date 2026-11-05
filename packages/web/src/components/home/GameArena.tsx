'use client';

import { useEffect, useRef } from 'react';

interface Brick {
  x: number;
  y: number;
  active: boolean;
}

export function GameArena() {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const context = canvas.getContext('2d');
    if (!context) return;

    let width = 0;
    const height = 256;
    let running = false;
    let paddleX = 0;
    let ballX = 0;
    let ballY = 0;
    let velocityX = 110;
    let velocityY = -140;
    let lastTime = 0;
    let frame = 0;
    let bricks: Brick[] = [];

    const resetBricks = () => {
      bricks = [];
      const columns = 8;
      const brickWidth = 50;
      const gap = 12;
      const startX = (width - (columns * brickWidth + (columns - 1) * gap)) / 2;
      for (let row = 0; row < 3; row += 1) {
        for (let column = 0; column < columns; column += 1) {
          bricks.push({ x: startX + column * (brickWidth + gap), y: 58 + row * 22, active: true });
        }
      }
    };

    const resetBall = () => {
      ballX = paddleX + 28;
      ballY = height - 38;
      velocityX = 110;
      velocityY = -140;
    };

    const resize = () => {
      width = canvas.clientWidth;
      const ratio = window.devicePixelRatio || 1;
      canvas.width = Math.round(width * ratio);
      canvas.height = Math.round(height * ratio);
      context.setTransform(ratio, 0, 0, ratio, 0, 0);
      context.imageSmoothingEnabled = false;
      paddleX = width * 0.22;
      resetBricks();
      resetBall();
    };

    const observer = new ResizeObserver(resize);
    observer.observe(canvas);
    resize();

    const draw = (time: number) => {
      const styles = getComputedStyle(canvas);
      const primary = styles.getPropertyValue('--text-primary').trim() || '#1a1a1a';
      const tertiary = styles.getPropertyValue('--text-tertiary').trim() || '#a6a6a6';
      const border = styles.getPropertyValue('--border-main').trim() || '#0000000f';
      const delta = Math.min((time - lastTime) / 1000 || 0, 0.025);
      lastTime = time;

      if (running) {
        ballX += velocityX * delta;
        ballY += velocityY * delta;
        if (ballX < 5 || ballX > width - 5) velocityX *= -1;
        if (ballY < 40) velocityY = Math.abs(velocityY);
        if (ballY > height - 32 && ballY < height - 20 && ballX >= paddleX && ballX <= paddleX + 56 && velocityY > 0) {
          velocityY = -Math.abs(velocityY);
          velocityX += (ballX - (paddleX + 28)) * 0.8;
        }
        for (const brick of bricks) {
          if (!brick.active) continue;
          if (ballX >= brick.x && ballX <= brick.x + 50 && ballY >= brick.y && ballY <= brick.y + 12) {
            brick.active = false;
            velocityY *= -1;
            break;
          }
        }
        if (ballY > height + 8 || bricks.every((brick) => !brick.active)) {
          running = false;
          resetBricks();
          resetBall();
        }
      }

      context.clearRect(0, 0, width, height);
      context.textAlign = 'center';
      context.font = '10px monospace';
      context.fillStyle = tertiary;
      context.globalAlpha = running ? 0.45 : 0.8;
      context.fillText(running ? 'BRICK BASH' : 'BRICK BASH - CLICK TO START', width / 2, 22);
      context.globalAlpha = 1;

      for (const brick of bricks) {
        if (!brick.active) continue;
        context.fillStyle = border;
        context.fillRect(brick.x, brick.y, 50, 12);
        context.strokeStyle = tertiary;
        context.globalAlpha = running ? 0.45 : 0.16;
        context.strokeRect(brick.x + 0.5, brick.y + 0.5, 49, 11);
        context.globalAlpha = 1;
      }

      context.fillStyle = primary;
      context.fillRect(paddleX, height - 26, 56, 6);
      if (running) {
        context.beginPath();
        context.arc(ballX, ballY, 4, 0, Math.PI * 2);
        context.fill();
      }
      frame = requestAnimationFrame(draw);
    };

    const start = () => {
      if (!running) {
        resetBricks();
        resetBall();
        running = true;
      }
    };
    const move = (event: PointerEvent) => {
      const rect = canvas.getBoundingClientRect();
      paddleX = Math.max(0, Math.min(width - 56, event.clientX - rect.left - 28));
      if (!running) resetBall();
    };
    const key = (event: KeyboardEvent) => {
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        start();
      }
    };

    canvas.addEventListener('pointermove', move);
    canvas.addEventListener('click', start);
    canvas.addEventListener('keydown', key);
    frame = requestAnimationFrame(draw);
    return () => {
      observer.disconnect();
      cancelAnimationFrame(frame);
      canvas.removeEventListener('pointermove', move);
      canvas.removeEventListener('click', start);
      canvas.removeEventListener('keydown', key);
    };
  }, []);

  return (
    <canvas
      ref={canvasRef}
      className="block h-64 w-full cursor-pointer select-none"
      role="button"
      tabIndex={0}
      aria-label="Brick Bash game area"
    />
  );
}
