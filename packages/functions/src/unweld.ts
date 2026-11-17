import {
	type Accessor,
	Document,
	type GLTF,
	Primitive,
	type Transform,
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
 * Primitives using primitive restart values (KHR_mesh_primitive_restart) are supported: restart
 * values end the current strip, fan, or loop and begin a new one, so affected primitives are
 * expanded to their basic topology (TRIANGLES or LINES) while de-indexing.
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

	// Resolve primitive restart values (KHR_mesh_primitive_restart), expanding
	// strip/fan/loop topology to its basic mode so restart boundaries survive
	// de-indexing. Without this, restart values would be copied verbatim into
	// vertex attributes, producing out-of-bounds reads and NaN vertices.
	let indicesArray: ArrayLike<number> = indices.getArray()!;
	const srcMode = prim.getMode() as GLTF.MeshPrimitiveMode;
	if (document.hasExtension('KHR_mesh_primitive_restart') && isPrimitiveRestartMode(srcMode)) {
		const restartIndex = getPrimitiveRestartIndex(indices.getComponentType());
		if (restartIndex >= 0 && (indicesArray as Uint8Array | Uint16Array | Uint32Array).includes(restartIndex)) {
			indicesArray = expandPrimitiveRestart(srcMode, indicesArray, restartIndex);
			prim.setMode(BASIC_MODE_MAPPING[srcMode]);
		}
	}

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

function unweldAttribute(
	document: Document,
	srcAttribute: Accessor,
	indices: Accessor,
	indicesArray: ArrayLike<number>,
	visited: Map<Accessor, Map<Accessor, Accessor>>,
): Accessor {
	if (visited.has(srcAttribute) && visited.get(srcAttribute)!.has(indices)) {
		return visited.get(srcAttribute)!.get(indices)!;
	}

	const srcArray = srcAttribute.getArray()!;
	const TypedArray = srcArray.constructor as TypedArrayConstructor;
	const elementSize = srcAttribute.getElementSize();
	const dstArray = new TypedArray(indicesArray.length * elementSize);

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

/**
 * Expands indices of a strip/fan/loop {@link Primitive} containing primitive
 * restart values (KHR_mesh_primitive_restart) into an index list for the
 * equivalent basic mode (TRIANGLES or LINES). A restart value ends the current
 * topological primitive; the next index begins a new one. Winding order of
 * triangle strips restarts with each new segment, matching GPU replay
 * semantics of the original strip.
 */
function expandPrimitiveRestart(
	mode: GLTF.MeshPrimitiveMode,
	srcArray: ArrayLike<number>,
	restartIndex: number,
): Uint32Array {
	const dst: number[] = [];

	switch (mode) {
		case Primitive.Mode.TRIANGLE_STRIP: {
			let a = -1;
			let b = -1;
			let parity = 0;
			for (let i = 0, il = srcArray.length; i < il; i++) {
				const index = srcArray[i];
				if (index === restartIndex) {
					a = b = -1;
					parity = 0;
					continue;
				}
				if (a === -1) {
					a = index;
					continue;
				}
				if (b === -1) {
					b = index;
					continue;
				}
				if (parity++ % 2 === 0) {
					dst.push(a, b, index);
				} else {
					dst.push(b, a, index);
				}
				a = b;
				b = index;
			}
			break;
		}
		case Primitive.Mode.TRIANGLE_FAN: {
			let center = -1;
			let prev = -1;
			for (let i = 0, il = srcArray.length; i < il; i++) {
				const index = srcArray[i];
				if (index === restartIndex) {
					center = prev = -1;
					continue;
				}
				if (center === -1) {
					center = index;
					continue;
				}
				if (prev === -1) {
					prev = index;
					continue;
				}
				dst.push(center, prev, index);
				prev = index;
			}
			break;
		}
		case Primitive.Mode.LINE_STRIP: {
			let prev = -1;
			for (let i = 0, il = srcArray.length; i < il; i++) {
				const index = srcArray[i];
				if (index === restartIndex) {
					prev = -1;
					continue;
				}
				if (prev !== -1) dst.push(prev, index);
				prev = index;
			}
			break;
		}
		case Primitive.Mode.LINE_LOOP: {
			let first = -1;
			let prev = -1;
			const closeSegment = (): void => {
				if (first !== -1 && prev !== -1) dst.push(prev, first);
				first = prev = -1;
			};
			for (let i = 0, il = srcArray.length; i < il; i++) {
				const index = srcArray[i];
				if (index === restartIndex) {
					closeSegment();
					continue;
				}
				if (first === -1) {
					first = prev = index;
					continue;
				}
				dst.push(prev, index);
				prev = index;
			}
			closeSegment();
			break;
		}
		default:
			throw new Error(`unweld: Unexpected primitive restart mode: ${mode}`);
	}

	return Uint32Array.from(dst);
}
