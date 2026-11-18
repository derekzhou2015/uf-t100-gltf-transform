import { deepEqual, ok, strictEqual } from 'node:assert/strict';
import { describe, test } from 'node:test';
import { Accessor, Document, Primitive } from '@gltf-transform/core';
import { KHRMeshPrimitiveRestart } from '@gltf-transform/extensions';
import { unweld } from '@gltf-transform/functions';

const { TRIANGLE_STRIP } = Primitive.Mode;

/**
 * Replays triangle strip topology, honoring primitive restart indices, and
 * returns the resulting triangles as flat triples of vertex indices. Winding
 * follows glTF TRIANGLE_STRIP semantics, alternating per triangle within a
 * strip; a restart ends the current strip and the next index starts a new
 * strip whose winding counter resets to its first (even) triangle.
 */
function replayTriangleStrips(indices: ArrayLike<number>, restartIndex: number): number[] {
	const triangles: number[] = [];
	const strips: number[][] = [];
	let strip: number[] = [];

	for (let i = 0; i < indices.length; i++) {
		if (indices[i] === restartIndex) {
			strips.push(strip);
			strip = [];
		} else {
			strip.push(indices[i]);
		}
	}
	strips.push(strip);

	for (const vertices of strips) {
		for (let i = 0; i + 2 < vertices.length; i++) {
			// Winding alternates with the triangle's position within THIS strip.
			// Odd triangles swap the first two vertices, matching glTF
			// TRIANGLE_STRIP winding (see convertPrimitiveToTriangles).
			if (i % 2 === 0) {
				triangles.push(vertices[i], vertices[i + 1], vertices[i + 2]);
			} else {
				triangles.push(vertices[i + 1], vertices[i], vertices[i + 2]);
			}
		}
	}

	return triangles;
}

/** Creates a VEC3 position accessor whose vertex N is at (N, 0, 0). */
function createPosition(document: Document, vertexCount: number): Accessor {
	const array = new Float32Array(vertexCount * 3);
	for (let i = 0; i < vertexCount; i++) array[i * 3] = i;
	return document.createAccessor().setType(Accessor.Type.VEC3).setArray(array);
}

describe('functions::unweld', () => {
	test('basic', async () => {
		const doc = new Document();
		const positionArray = new Float32Array([0, 0, 0, 0, 0, 1, 0, 0, -1, 0, 1, 0, 0, -1, 0, 1, 0, 0, -1, 0, 0]);
		const position = doc.createAccessor().setType(Accessor.Type.VEC3).setArray(positionArray);
		const indices1 = doc.createAccessor().setArray(new Uint32Array([0, 3, 5, 0, 3, 6]));
		const indices2 = doc.createAccessor().setArray(new Uint32Array([0, 3, 5, 1, 4, 5]));
		const prim1 = doc
			.createPrimitive()
			.setIndices(indices1)
			.setAttribute('POSITION', position)
			.setMode(Primitive.Mode.TRIANGLES);
		const prim2 = doc
			.createPrimitive()
			.setIndices(indices2)
			.setAttribute('POSITION', position)
			.setMode(Primitive.Mode.TRIANGLES);
		const prim3 = doc.createPrimitive().setAttribute('POSITION', position).setMode(Primitive.Mode.TRIANGLE_FAN);
		doc.createMesh().addPrimitive(prim1).addPrimitive(prim2).addPrimitive(prim3);

		await doc.transform(unweld());

		strictEqual(prim1.getIndices(), null, 'no index on prim1');
		strictEqual(prim2.getIndices(), null, 'no index on prim2');
		strictEqual(prim3.getIndices(), null, 'no index on prim3');

		deepEqual(
			prim1.getAttribute('POSITION').getArray(),
			new Float32Array([0, 0, 0, 0, 1, 0, 1, 0, 0, 0, 0, 0, 0, 1, 0, -1, 0, 0]),
			'subset of vertices in prim1',
		);
		deepEqual(
			prim2.getAttribute('POSITION').getArray(),
			new Float32Array([0, 0, 0, 0, 1, 0, 1, 0, 0, 0, 0, 1, 0, -1, 0, 1, 0, 0]),
			'subset of vertices in prim2',
		);
		deepEqual(prim3.getAttribute('POSITION').getArray(), positionArray, 'original vertices in prim3');
		strictEqual(doc.getRoot().listAccessors().length, 3, 'keeps only needed accessors');
	});

	test('triangle strip with single primitive restart', async () => {
		const document = new Document();
		document.createExtension(KHRMeshPrimitiveRestart).setRequired(true);

		const RESTART_U16 = 2 ** 16 - 1;
		const vertexCount = 8;
		const position = createPosition(document, vertexCount);

		// Two triangle strips: [0,1,2,3] then [4,5,6,7], joined by one restart.
		const srcIndices = new Uint16Array([0, 1, 2, 3, RESTART_U16, 4, 5, 6, 7]);
		const indices = document.createAccessor().setArray(srcIndices);
		const prim = document
			.createPrimitive()
			.setMode(TRIANGLE_STRIP)
			.setIndices(indices)
			.setAttribute('POSITION', position);
		document.createMesh().addPrimitive(prim);

		// Expected triangle set, replayed from the restart-delimited strips.
		const expectedTriangles = replayTriangleStrips(srcIndices, RESTART_U16);

		await document.transform(unweld());

		strictEqual(prim.getIndices(), null, 'de-indexed');
		strictEqual(prim.getMode(), Primitive.Mode.TRIANGLES, 'restart strip replayed as TRIANGLES');

		const dstPosition = prim.getAttribute('POSITION')!;
		const dstArray = dstPosition.getArray()!;

		// One expanded vertex per replayed triangle vertex; the restart index
		// references no vertex and produces no output.
		strictEqual(dstPosition.getCount(), expectedTriangles.length, 'vertex count matches replay');
		strictEqual(dstArray.length, expectedTriangles.length * 3, 'attribute length matches replay');

		// No NaN coordinates, and every expanded vertex maps to an in-range source vertex.
		ok(
			Array.from(dstArray).every((v) => Number.isFinite(v)),
			'no NaN coordinates',
		);
		ok(
			expectedTriangles.every((vertexIndex) => vertexIndex < vertexCount),
			'no out-of-range vertex reference',
		);

		// Expanded vertices, read as flat triangle triples, equal the replayed
		// triangle set including winding order.
		const expandedTriangles: number[] = [];
		for (let i = 0; i < dstPosition.getCount(); i++) {
			expandedTriangles.push(dstArray[i * 3]);
		}
		deepEqual(expandedTriangles, expectedTriangles, 'triangle set matches strip replay across restart');

		// The two strips must not fuse: no triangle spans the restart boundary,
		// and each new strip restarts with forward winding.
		deepEqual(
			expandedTriangles,
			[0, 1, 2, 2, 1, 3, 4, 5, 6, 6, 5, 7],
			'strips remain separate with correct winding',
		);
	});

	test('triangle strip with multiple primitive restarts', async () => {
		const document = new Document();
		document.createExtension(KHRMeshPrimitiveRestart).setRequired(true);

		const RESTART_U32 = 2 ** 32 - 1;
		const vertexCount = 12;
		const position = createPosition(document, vertexCount);
		const positionArray = position.getArray()!;

		// Three triangle strips separated by two restart indices.
		const srcIndices = new Uint32Array([0, 1, 2, RESTART_U32, 3, 4, 5, 6, RESTART_U32, 7, 8, 9, 10, 11]);
		const indices = document.createAccessor().setArray(srcIndices);
		const prim = document
			.createPrimitive()
			.setMode(TRIANGLE_STRIP)
			.setIndices(indices)
			.setAttribute('POSITION', position);
		document.createMesh().addPrimitive(prim);

		const expectedTriangles = replayTriangleStrips(srcIndices, RESTART_U32);

		await document.transform(unweld());

		strictEqual(prim.getIndices(), null, 'de-indexed');
		strictEqual(prim.getMode(), Primitive.Mode.TRIANGLES, 'restart strip replayed as TRIANGLES');

		const dstPosition = prim.getAttribute('POSITION')!;
		const dstArray = dstPosition.getArray()!;

		// Strips [0,1,2], [3,4,5,6], [7,8,9,10,11] emit 1 + 2 + 3 = 6 triangles,
		// i.e. 18 expanded vertices; both restart indices produce no vertices.
		strictEqual(expectedTriangles.length, 6 * 3, 'three strips emit six triangles');
		strictEqual(dstPosition.getCount(), 18, 'vertex count excludes both restart indices');
		ok(
			Array.from(dstArray).every((v) => Number.isFinite(v)),
			'no NaN coordinates',
		);

		const expandedTriangles: number[] = [];
		for (let i = 0; i < dstPosition.getCount(); i++) {
			const srcIndex = dstArray[i * 3];
			ok(srcIndex < vertexCount, 'no out-of-range vertex reference');
			for (let j = 0; j < 3; j++) {
				strictEqual(
					dstArray[i * 3 + j],
					positionArray[srcIndex * 3 + j],
					`expanded vertex ${i} component ${j}`,
				);
			}
			expandedTriangles.push(srcIndex);
		}

		// Triangle set must match strip replay, with no triangle fused across
		// either restart boundary.
		deepEqual(expandedTriangles, expectedTriangles, 'triangle set matches strip replay across restarts');
		deepEqual(
			expandedTriangles,
			[0, 1, 2, 3, 4, 5, 5, 4, 6, 7, 8, 9, 9, 8, 10, 9, 10, 11],
			'three strips remain separate with correct winding',
		);
	});

	test('line strip with primitive restart', async () => {
		const document = new Document();
		document.createExtension(KHRMeshPrimitiveRestart).setRequired(true);

		const RESTART_U8 = 2 ** 8 - 1;
		const position = createPosition(document, 5);

		// Two line strips: [0,1] and [2,3,4].
		const srcIndices = new Uint8Array([0, 1, RESTART_U8, 2, 3, 4]);
		const indices = document.createAccessor().setArray(srcIndices);
		const prim = document
			.createPrimitive()
			.setMode(Primitive.Mode.LINE_STRIP)
			.setIndices(indices)
			.setAttribute('POSITION', position);
		document.createMesh().addPrimitive(prim);

		await document.transform(unweld());

		strictEqual(prim.getIndices(), null, 'de-indexed');
		strictEqual(prim.getMode(), Primitive.Mode.LINES, 'restart line strip replayed as LINES');

		const dstArray = prim.getAttribute('POSITION')!.getArray()!;
		// Lines (0,1), (2,3), (3,4): six expanded vertices, no restart slot.
		deepEqual(Array.from(dstArray.filter((_, i) => i % 3 === 0)), [0, 1, 2, 3, 3, 4], 'line set matches replay');
		ok(
			Array.from(dstArray).every((v) => Number.isFinite(v)),
			'no NaN coordinates',
		);
	});

	test('non-restart strip topology unchanged', async () => {
		const document = new Document();
		document.createExtension(KHRMeshPrimitiveRestart).setRequired(true);

		const position = createPosition(document, 5);
		const srcIndices = new Uint16Array([0, 1, 2, 3, 4]);
		const indices = document.createAccessor().setArray(srcIndices);
		const prim = document
			.createPrimitive()
			.setMode(TRIANGLE_STRIP)
			.setIndices(indices)
			.setAttribute('POSITION', position);
		document.createMesh().addPrimitive(prim);

		await document.transform(unweld());

		strictEqual(prim.getIndices(), null, 'de-indexed');
		strictEqual(prim.getMode(), TRIANGLE_STRIP, 'mode unchanged without restart indices');
		const dstArray = prim.getAttribute('POSITION')!.getArray()!;
		strictEqual(dstArray.length, srcIndices.length * 3, 'one vertex per index when no restart is present');
		for (let i = 0; i < srcIndices.length; i++) {
			strictEqual(dstArray[i * 3], srcIndices[i], 'vertex order preserved');
		}
	});
});
