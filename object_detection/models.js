const path = require('node:path');

const MODELS_DIR = path.join(__dirname, '..', 'models');

// Official YOLOX ONNX exports, Apache-2.0: https://github.com/Megvii-BaseDetection/YOLOX
// cocoMap is the authors' published COCO val2017 mAP@0.5:0.95 at 416x416; sha256 was computed on download.
const MODELS = Object.freeze({
  'yolox-tiny': Object.freeze({
    file: 'yolox_tiny.onnx',
    url: 'https://github.com/Megvii-BaseDetection/YOLOX/releases/download/0.1.1rc0/yolox_tiny.onnx',
    sha256: '427cc366d34e27ff7a03e2899b5e3671425c262ea2291f88bb942bc1cc70b0f7',
    bytes: 20_219_662,
    license: 'Apache-2.0',
    cocoMap: 32.8,
  }),
  'yolox-nano': Object.freeze({
    file: 'yolox_nano.onnx',
    url: 'https://github.com/Megvii-BaseDetection/YOLOX/releases/download/0.1.1rc0/yolox_nano.onnx',
    sha256: 'c789161ed43c8269fcd4e67c67eeeb4e80c622da2eb296a20bc6007bd18a0b7d',
    bytes: 3_659_407,
    license: 'Apache-2.0',
    cocoMap: 25.8,
  }),
});

const DEFAULT_MODEL = 'yolox-tiny';

const modelPath = (name) => path.join(MODELS_DIR, MODELS[name].file);

module.exports = { MODELS, MODELS_DIR, DEFAULT_MODEL, modelPath };
