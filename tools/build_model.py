#!/usr/bin/env python3
"""Make app/models/isnet-general-h2f.onnx from rembg's copy of IS-Net (DIS, general use).

    pip install --target /tmp/onnxlib onnx    # if onnx isn't installed
    PYTHONPATH=/tmp/onnxlib tools/build_model.py

Three changes, none of which changes the answer for a 1024x1024 input:
  1. keep only the final mask output (the five side outputs are for training);
  2. store the weights as float16 with a Cast back to float32 in front of each,
     which halves the download (176 -> 90 MB) while the maths stays float32,
     so it runs on any WebGPU device and on the CPU (ORT folds the casts at load);
  3. MaxPool ceil_mode 1 -> 0. ORT Web's WebGPU MaxPool doesn't do ceil_mode yet,
     and with a 1024 input every map it pools has an even size, so it's identical.
"""
import hashlib, os, sys, urllib.request
import numpy as np
import onnx
from onnx import TensorProto, helper, numpy_helper

URL = "https://github.com/danielgatis/rembg/releases/download/v0.0.0/isnet-general-use.onnx"
HERE = os.path.dirname(os.path.abspath(__file__))
SRC = os.path.join(HERE, "..", "isnet-general-use.onnx")
OUT = os.path.join(HERE, "..", "app", "models", "isnet-general-h2f.onnx")

if not os.path.exists(SRC):
    print("downloading", URL)
    urllib.request.urlretrieve(URL, SRC)

m = onnx.load(SRC)
m = onnx.utils.Extractor(m).extract_model(["input_image"], ["output_image"])
g = m.graph
casts, halves = [], []
for init in list(g.initializer):
    if init.data_type == TensorProto.FLOAT and int(np.prod(init.dims)) > 16:
        h = numpy_helper.from_array(numpy_helper.to_array(init).astype(np.float16), init.name + "_h")
        halves.append(h)
        casts.append(helper.make_node("Cast", [h.name], [init.name], to=TensorProto.FLOAT, name="cast_" + init.name))
        g.initializer.remove(init)
g.initializer.extend(halves)
nodes = list(g.node)
del g.node[:]
g.node.extend(casts + nodes)
for node in g.node:
    if node.op_type == "MaxPool":
        for a in node.attribute:
            if a.name == "ceil_mode":
                a.i = 0
onnx.checker.check_model(m)
os.makedirs(os.path.dirname(OUT), exist_ok=True)
onnx.save(m, OUT)
data = open(OUT, "rb").read()
print(OUT, len(data), "bytes, sha256", hashlib.sha256(data).hexdigest()[:16])
print("If the size changed, update MODEL_BYTES in app/cutout.js and bump CACHE.")
