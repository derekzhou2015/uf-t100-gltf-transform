import {
	type Accessor,
	Document,
	type GLTF,
	Primitive,
	type Transform,
	type TypedArray,
	type TypedArrayConstructor,
} from '@gltf-transform/core';
import {
	BASIC_MODE_MAPPING,
	createTransform,
	formatDeltaOp,
	getPrimitiveRestartIndex,
	isPrimitiveRestartMode,
	shallowCloneAccessor,
} from './utils.js';

const NAME = 'unweld';

/** Options for the {@link unweld} function. */
export interface UnweldOptions {}

const UNWELD_DEFAULTS: UnweldOptions = {};

/**
 * De-index {@link Primitive}s, disconnecting any shared vertices. This operation will generally
 * increase the number of vertices in a mesh, but may be helpful for some geometry operations or
 * for creating hard edges.
 *
 * No options are currently implemented for this function.
 *
 * @category Transforms
 */
export function unweld(_options: UnweldOptions = UNWELD_DEFAULTS): Transform {
	return createTransform(NAME, (doc: Document): void => {
		const logger = doc.getLogger();
		const visited = new Map<Accessor, Map<Accessor, Accessor>>();

		for (const mesh of doc.getRoot().listMeshes()) {
			for (const prim of mesh.listPrimitives()) {
				unweldPrimitive(prim, visited);
			}
		}

		logger.debug(`${NAME}: Complete.`);
	});
}

/**
 * @hidden
 * @internal
 */
export function unweldPrimitive(prim: Primitive, visited = new Map<Accessor, Map<Accessor, Accessor>>()): void {
	const indices = prim.getIndices();
	if (!indices) return;

	const graph = prim.getGraph();
	const document = Document.fromGraph(graph)!;
	const logger = document.getLogger();

	const srcVertexCount = prim.getAttribute('POSITION')!.getCount();

	// Primitive restart indices (KHR_mesh_primitive_restart) delimit topological
	// primitives and reference no vertex. A de-indexed primitive cannot carry
	// restart indices, so restart-delimited strips, loops, and fans are first
	// replayed into their basic topology (TRIANGLES or LINES), with one output
	// index per replayed vertex. This preserves the exact triangle/line set of
	// the restart-aware replay, with no out-of-range reads or NaN vertices.
	const indicesArray = explodePrimitiveRestart(prim, indices);

	// Vertex attributes.
	for (const srcAttribute of prim.listAttributes()) {
		prim.swap(srcAttribute, unweldAttribute(document, srcAttribute, indices, indicesArray, visited));

		// Clean up.
		if (srcAttribute.listParents().length === 1) srcAttribute.dispose();
	}

	// Morph target vertex attributes.
	for (const target of prim.listTargets()) {
		for (const srcAttribute of target.listAttributes()) {
			target.swap(srcAttribute, unweldAttribute(document, srcAttribute, indices, indicesArray, visited));

			// Clean up.
			if (srcAttribute.listParents().length === 1) srcAttribute.dispose();
		}
	}

	const dstVertexCount = prim.getAttribute('POSITION')!.getCount();
	logger.debug(`${NAME}: ${formatDeltaOp(srcVertexCount, dstVertexCount)} vertices.`);

	// Clean up.
	prim.setIndices(null);
	if (indices.listParents().length === 1) indices.dispose();
}

/**
 * Replays a restart-delimited indexed primitive into the index sequence of its
 * basic topology, honoring primitive restart indices (KHR_mesh_primitive_restart):
 * a restart index ends the current topological primitive, and the next index
 * begins a new one. Triangle strips and fans become `TRIANGLES`, line strips and
 * loops become `LINES`. Primitives without restart indices are returned
 * unchanged, keeping their existing mode and topology.
 * @hidden
 */
function explodePrimitiveRestart(prim: Primitive, indices: Accessor): TypedArray {
	const srcArray = indices.getArray()!;

	if (!isPrimitiveRestartMode(prim.getMode())) return srcArray;

	const restartIndex = getPrimitiveRestartIndex(indices.getComponentType());
	let containsRestart = false;
	for (let i = 0, il = srcArray.length; i < il; i++) {
		if (srcArray[i] === restartIndex) {
			containsRestart = true;
			break;
		}
	}
	if (!containsRestart) return srcArray;

	const mode = prim.getMode();
	const verticesPerPrimitive = mode === Primitive.Mode.TRIANGLE_STRIP || mode === Primitive.Mode.TRIANGLE_FAN ? 3 : 2;
	const dstArray = new (srcArray.constructor as TypedArrayConstructor)(srcArray.length * verticesPerPrimitive);

	let offset = 0;
	let segmentStart = 0;

	const replaySegment = (segmentEnd: number): void => {
		const length = segmentEnd - segmentStart;
		if (mode === Primitive.Mode.TRIANGLE_STRIP) {
			// https://en.wikipedia.org/wiki/Triangle_strip, winding alternates.
			for (let i = 0; i + 2 < length; i++) {
				if (i % 2 === 0) {
					dstArray[offset++] = srcArray[segmentStart + i];
					dstArray[offset++] = srcArray[segmentStart + i + 1];
					dstArray[offset++] = srcArray[segmentStart + i + 2];
				} else {
					dstArray[offset++] = srcArray[segmentStart + i + 1];
					dstArray[offset++] = srcArray[segmentStart + i];
					dstArray[offset++] = srcArray[segmentStart + i + 2];
				}
			}
		} else if (mode === Primitive.Mode.TRIANGLE_FAN) {
			// https://en.wikipedia.org/wiki/Triangle_fan
			for (let i = 1; i + 1 < length; i++) {
				dstArray[offset++] = srcArray[segmentStart];
				dstArray[offset++] = srcArray[segmentStart + i];
				dstArray[offset++] = srcArray[segmentStart + i + 1];
			}
		} else if (mode === Primitive.Mode.LINE_STRIP) {
			for (let i = 0; i + 1 < length; i++) {
				dstArray[offset++] = srcArray[segmentStart + i];
				dstArray[offset++] = srcArray[segmentStart + i + 1];
			}
		} else {
			// LINE_LOOP: like a line strip, plus a closing line back to the first vertex.
			for (let i = 0; i + 1 < length; i++) {
				dstArray[offset++] = srcArray[segmentStart + i];
				dstArray[offset++] = srcArray[segmentStart + i + 1];
			}
			if (length >= 2) {
				dstArray[offset++] = srcArray[segmentStart + length - 1];
				dstArray[offset++] = srcArray[segmentStart];
			}
		}
	};

	for (let i = 0, il = srcArray.length; i < il; i++) {
		if (srcArray[i] === restartIndex) {
			replaySegment(i);
			segmentStart = i + 1;
		}
	}
	replaySegment(srcArray.length);

	// The replayed primitive no longer uses restart indices or strip topology.
	prim.setMode(BASIC_MODE_MAPPING[mode as GLTF.MeshPrimitiveMode]);

	return dstArray.subarray(0, offset);
}

function unweldAttribute(
	document: Document,
	srcAttribute: Accessor,
	indices: Accessor,
	indicesArray: TypedArray,
	visited: Map<Accessor, Map<Accessor, Accessor>>,
): Accessor {
	if (visited.has(srcAttribute) && visited.get(srcAttribute)!.has(indices)) {
		return visited.get(srcAttribute)!.get(indices)!;
	}

	const srcArray = srcAttribute.getArray()!;
	const TypedArray = srcArray.constructor as TypedArrayConstructor;
	const dstArray = new TypedArray(indicesArray.length * srcAttribute.getElementSize());

	const elementSize = srcAttribute.getElementSize();
	for (let i = 0, il = indicesArray.length; i < il; i++) {
		for (let j = 0; j < elementSize; j++) {
			dstArray[i * elementSize + j] = srcArray[indicesArray[i] * elementSize + j];
		}
	}

	if (!visited.has(srcAttribute)) visited.set(srcAttribute, new Map());
	const dstAttribute = shallowCloneAccessor(document, srcAttribute).setArray(dstArray);
	visited.get(srcAttribute)!.set(indices, dstAttribute);

	return dstAttribute;
}
