---
title: GuitarGod Stems
emoji: 🎸
colorFrom: red
colorTo: orange
sdk: docker
pinned: false
---

# GuitarGod Stem Separator

Flask API for Demucs-based audio stem separation used by [GuitarGod](https://amenlemiesa.github.io/GuitarGod/).

## Endpoint

`POST /separate`  
Form fields: `file` (audio file), `mode` (vocals / bass / drums / guitar)  
Returns: `audio/mpeg` MP3 of the separated stem
