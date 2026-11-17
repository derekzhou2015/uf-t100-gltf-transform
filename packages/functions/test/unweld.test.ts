import { deepEqual, strictEqual } from 'node:assert/strict';
import { describe, test } from 'node:test';
import { Accessor, Document, Primitive } from '@gltf-transform/core';
import { KHRMeshPrimitiveRestart } from '@gltf-transform/extensions';
import { unweld } from '@gltf-transform/functions';

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
		const doc = new Document();
		doc.createExtension(KHRMeshPrimitiveRestart);

		// 10 vertices, vertex i at [i, 0, 0].
		const positionArray = new Float32Array(30).map((_, i) => (i % 3 === 0 ? i / 3 : 0));
		const position = doc.createAccessor().setType(Accessor.Type.VEC3).setArray(positionArray);
		const indices = doc.createAccessor().setArray(new Uint16Array([0, 1, 2, 3, 0xffff, 4, 5, 6, 7]));
		const prim = doc
			.createPrimitive()
			.setMode(Primitive.Mode.TRIANGLE_STRIP)
			.setAttribute('POSITION', position)
			.setIndices(indices);
		doc.createMesh().addPrimitive(prim);

		await doc.transform(unweld());

		strictEqual(prim.getIndices(), null, 'no index on prim');
		strictEqual(prim.getMode(), Primitive.Mode.TRIANGLES, 'strip expanded to triangles');

		// Strip replay: [0,1,2,3] → (0,1,2),(2,1,3); restart; [4,5,6,7] → (4,5,6),(6,5,7).
		const expectedIndices = [0, 1, 2, 2, 1, 3, 4, 5, 6, 6, 5, 7];
		const expectedPositions = new Float32Array(expectedIndices.flatMap((i) => [i, 0, 0]));
		deepEqual(prim.getAttribute('POSITION').getArray(), expectedPositions, 'triangles match strip replay');
		strictEqual(
			prim
				.getAttribute('POSITION')!
				.getArray()!
				.every((value) => Number.isFinite(value)),
			true,
			'no NaN or infinite vertex data',
		);
	});

	test('triangle strip with multiple primitive restarts', async () => {
		const doc = new Document();
		doc.createExtension(KHRMeshPrimitiveRestart);

		// 10 vertices, vertex i at [i, 0, 0].
		const positionArray = new Float32Array(30).map((_, i) => (i % 3 === 0 ? i / 3 : 0));
		const position = doc.createAccessor().setType(Accessor.Type.VEC3).setArray(positionArray);
		const indices = doc.createAccessor().setArray(new Uint16Array([0, 1, 2, 0xffff, 3, 4, 5, 6, 0xffff, 7, 8, 9]));
		const prim = doc
			.createPrimitive()
			.setMode(Primitive.Mode.TRIANGLE_STRIP)
			.setAttribute('POSITION', position)
			.setIndices(indices);
		doc.createMesh().addPrimitive(prim);

		await doc.transform(unweld());

		strictEqual(prim.getIndices(), null, 'no index on prim');
		strictEqual(prim.getMode(), Primitive.Mode.TRIANGLES, 'strip expanded to triangles');

		// Strip replay: [0,1,2] → (0,1,2); [3,4,5,6] → (3,4,5),(5,4,6); [7,8,9] → (7,8,9).
		const expectedIndices = [0, 1, 2, 3, 4, 5, 5, 4, 6, 7, 8, 9];
		const expectedPositions = new Float32Array(expectedIndices.flatMap((i) => [i, 0, 0]));
		deepEqual(prim.getAttribute('POSITION').getArray(), expectedPositions, 'triangles match strip replay');
		strictEqual(
			prim
				.getAttribute('POSITION')!
				.getArray()!
				.every((value) => Number.isFinite(value)),
			true,
			'no NaN or infinite vertex data',
		);
	});

	test('triangle strip without primitive restart is unchanged', async () => {
		const doc = new Document();
		doc.createExtension(KHRMeshPrimitiveRestart);

		const positionArray = new Float32Array(12).map((_, i) => (i % 3 === 0 ? i / 3 : 0));
		const position = doc.createAccessor().setType(Accessor.Type.VEC3).setArray(positionArray);
		const indices = doc.createAccessor().setArray(new Uint16Array([0, 1, 2, 3]));
		const prim = doc
			.createPrimitive()
			.setMode(Primitive.Mode.TRIANGLE_STRIP)
			.setAttribute('POSITION', position)
			.setIndices(indices);
		doc.createMesh().addPrimitive(prim);

		await doc.transform(unweld());

		strictEqual(prim.getIndices(), null, 'no index on prim');
		strictEqual(prim.getMode(), Primitive.Mode.TRIANGLE_STRIP, 'mode preserved without restart values');
		deepEqual(prim.getAttribute('POSITION').getArray(), positionArray, 'original vertices in prim');
	});
});
