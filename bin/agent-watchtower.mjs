#!/usr/bin/env node
// 설치형 명령(npx / 전역 설치)의 진입점. 화면을 브라우저에 바로 띄운다 (--no-open 으로 끌 수 있음).
import { main } from '../server.mjs';

main(process.argv.slice(2), { openDefault: true });
