// CourseForgeImporter.cs
// Place this file inside Assets/Editor/ in your Unity project.
// Menu: Tools > Course Forge > Import Course
//
// Reads a *_course_data.json file exported from Course Forge and:
//   1. Paints rough / fairway terrain layers based on polygon data
//   2. Places tree instances at LiDAR-detected positions scaled by density setting
//
// Requirements:
//   - A Unity Terrain object must exist in the scene.
//   - The terrain must have at least 2 TerrainLayers assigned:
//       index 0 = rough texture  (matches roughType in JSON)
//       index 1 = fairway texture
//   - Add tree prefabs to the terrain's Tree Prototypes list before importing.

using System;
using System.Collections.Generic;
using System.IO;
using UnityEditor;
using UnityEngine;

public static class CourseForgeImporter
{
    // ─── Menu entry ────────────────────────────────────────────────────────────
    [MenuItem("Tools/Course Forge/Import Course")]
    public static void ImportCourse()
    {
        string jsonPath = EditorUtility.OpenFilePanel(
            "Select Course Forge JSON", "", "json");
        if (string.IsNullOrEmpty(jsonPath)) return;

        Terrain terrain = FindActiveTerrain();
        if (terrain == null)
        {
            EditorUtility.DisplayDialog("Course Forge",
                "No active Terrain found in the scene.\nAdd a Terrain object first.", "OK");
            return;
        }

        string json = File.ReadAllText(jsonPath);
        CourseData data = JsonUtility.FromJson<CourseData>(json);
        if (data == null)
        {
            EditorUtility.DisplayDialog("Course Forge", "Failed to parse JSON.", "OK");
            return;
        }

        Undo.RecordObject(terrain.terrainData, "Course Forge Import");

        PaintTerrain(terrain, data);
        PlaceTrees(terrain, data);

        EditorUtility.SetDirty(terrain.terrainData);
        AssetDatabase.SaveAssets();

        int treeCount = Mathf.RoundToInt((data.detectedTrees?.Length ?? 0) * data.treeDensity);
        EditorUtility.DisplayDialog("Course Forge",
            $"Import complete!\n" +
            $"  Rough type : {data.roughType}\n" +
            $"  Trees placed: {treeCount}\n" +
            $"  Holes mapped: {data.holes?.Length ?? 0}", "OK");
    }

    // ─── Terrain painting ──────────────────────────────────────────────────────
    static void PaintTerrain(Terrain terrain, CourseData data)
    {
        TerrainData td = terrain.terrainData;
        int res = td.alphamapResolution;
        int layerCount = td.terrainLayers.Length;

        if (layerCount < 2)
        {
            Debug.LogWarning("[CourseForge] Terrain needs at least 2 TerrainLayers " +
                             "(index 0 = rough, index 1 = fairway). Skipping paint.");
            return;
        }

        float[,,] alphas = new float[res, res, layerCount];

        // Build list of fairway polygons (all holes combined)
        List<Vector2[]> fairways = new List<Vector2[]>();
        if (data.holes != null)
        {
            foreach (var hole in data.holes)
            {
                if (hole.features == null) continue;
                foreach (var feat in hole.features)
                {
                    if (feat.type == "fairway" || feat.type == "green_area")
                        fairways.Add(FeatureToNorm(feat, data.bounds));
                }
            }
        }

        EditorUtility.DisplayProgressBar("Course Forge", "Painting terrain…", 0f);

        for (int z = 0; z < res; z++)
        {
            if (z % 32 == 0)
                EditorUtility.DisplayProgressBar("Course Forge", "Painting terrain…", z / (float)res);

            for (int x = 0; x < res; x++)
            {
                // Terrain alphamap: first index = z (north), second = x (east)
                // Normalised coords: (0,0)=SW corner, (1,1)=NE corner
                float nx = x / (float)(res - 1);
                float nz = z / (float)(res - 1);
                Vector2 pt = new Vector2(nx, nz);

                bool inFairway = false;
                foreach (var poly in fairways)
                {
                    if (PointInPolygon(pt, poly)) { inFairway = true; break; }
                }

                alphas[z, x, 0] = inFairway ? 0f : 1f; // rough layer
                alphas[z, x, 1] = inFairway ? 1f : 0f; // fairway layer
                // remaining layers stay 0
            }
        }

        td.SetAlphamaps(0, 0, alphas);
        EditorUtility.ClearProgressBar();
    }

    // ─── Tree placement ────────────────────────────────────────────────────────
    static void PlaceTrees(Terrain terrain, CourseData data)
    {
        if (data.detectedTrees == null || data.detectedTrees.Length == 0) return;
        if (terrain.terrainData.treePrototypes.Length == 0)
        {
            Debug.LogWarning("[CourseForge] No Tree Prototypes on terrain. " +
                             "Add at least one prototype before importing.");
            return;
        }

        TerrainData td = terrain.terrainData;
        Bounds b = data.bounds;
        float density = Mathf.Clamp01(data.treeDensity);

        var instances = new List<TreeInstance>(td.treeInstances);
        int placed = 0;

        System.Random rng = new System.Random(42);
        foreach (var t in data.detectedTrees)
        {
            if (rng.NextDouble() > density) continue; // respect density setting

            float nx = Mathf.InverseLerp((float)b.west,  (float)b.east,  (float)t.lng);
            float nz = Mathf.InverseLerp((float)b.south, (float)b.north, (float)t.lat);
            if (nx < 0 || nx > 1 || nz < 0 || nz > 1) continue;

            float ny = terrain.SampleHeight(
                terrain.transform.position + new Vector3(nx * td.size.x, 0, nz * td.size.z));

            float scale = Mathf.Clamp(0.6f + (float)t.heightAboveGround / 20f, 0.5f, 2.0f);
            int protoIndex = rng.Next(0, td.treePrototypes.Length);

            instances.Add(new TreeInstance
            {
                position        = new Vector3(nx, ny / td.size.y, nz),
                widthScale      = scale,
                heightScale     = scale,
                color           = Color.white,
                lightmapColor   = Color.white,
                prototypeIndex  = protoIndex,
            });
            placed++;
        }

        td.treeInstances = instances.ToArray();
        Debug.Log($"[CourseForge] Placed {placed} trees.");
    }

    // ─── Helpers ───────────────────────────────────────────────────────────────

    static Terrain FindActiveTerrain()
    {
        if (Terrain.activeTerrain != null) return Terrain.activeTerrain;
        return UnityEngine.Object.FindObjectOfType<Terrain>();
    }

    /// Convert a feature's lat/lng points to normalised (0-1) terrain coordinates.
    static Vector2[] FeatureToNorm(Feature feat, Bounds b)
    {
        var pts = new Vector2[feat.points.Length];
        for (int i = 0; i < feat.points.Length; i++)
        {
            pts[i] = new Vector2(
                Mathf.InverseLerp((float)b.west,  (float)b.east,  (float)feat.points[i].lng),
                Mathf.InverseLerp((float)b.south, (float)b.north, (float)feat.points[i].lat));
        }
        return pts;
    }

    /// Ray-casting point-in-polygon test (works for simple/convex polygons).
    static bool PointInPolygon(Vector2 p, Vector2[] poly)
    {
        bool inside = false;
        for (int i = 0, j = poly.Length - 1; i < poly.Length; j = i++)
        {
            if (((poly[i].y > p.y) != (poly[j].y > p.y)) &&
                (p.x < (poly[j].x - poly[i].x) * (p.y - poly[i].y)
                         / (poly[j].y - poly[i].y) + poly[i].x))
                inside = !inside;
        }
        return inside;
    }

    // ─── JSON-serializable data model ─────────────────────────────────────────

    [Serializable]
    public class CourseData
    {
        public string   name;
        public string   roughType;
        public float    treeDensity;
        public Hole[]   holes;
        public TreeCandidate[] detectedTrees;
        public Bounds   bounds;
    }

    [Serializable]
    public class Hole
    {
        public int      number;
        public int      par;
        public int      yardage;
        public Feature[] features;
    }

    [Serializable]
    public class Feature
    {
        public string type;
        public LatLng[] points;
    }

    [Serializable]
    public class LatLng
    {
        public double lat;
        public double lng;
    }

    [Serializable]
    public class TreeCandidate
    {
        public double lat;
        public double lng;
        public float  heightAboveGround;
    }

    [Serializable]
    public class Bounds
    {
        public double north;
        public double south;
        public double east;
        public double west;
    }
}
