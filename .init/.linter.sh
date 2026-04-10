#!/bin/bash
cd /tmp/code-generation/crayon-canvas-2474-2488/frontend
npm run build
EXIT_CODE=$?
if [ $EXIT_CODE -ne 0 ]; then
   exit 1
fi

