cbuffer _13_15 : register(b1, space0)

{

    float4 _15_m0[53] : packoffset(c0);

};



cbuffer _18_20 : register(b4, space0)

{

    float4 _20_m0[6] : packoffset(c0);

};



cbuffer _23_25 : register(b5, space0)

{

    float4 _25_m0[7] : packoffset(c0);

};



Texture2D<float4> _8 : register(t0, space0);



static float4 gl_Position;

static float gl_ClipDistance[1];

static int gl_VertexIndex;

static int gl_InstanceIndex;

static int gl_BaseVertexARB;

static int gl_BaseInstanceARB;

cbuffer SPIRV_Cross_VertexInfo

{

    int SPIRV_Cross_BaseVertex;

    int SPIRV_Cross_BaseInstance;

};



static float3 POSITION;

static float2 TEXCOORD;

static float3 NORMAL;

static float4 TANGENT;

static float4 COLOR;

static float2 TEXCOORD_1;

static float4 TEXCOORD_2;

static float4 TEXCOORD_1_1;

static float4 TEXCOORD_2_1;

static float4 TEXCOORD_3;

static float4 TEXCOORD_4;

static float TEXCOORD_5;



struct SPIRV_Cross_Input

{

    float3 POSITION : TEXCOORD0;

    float2 TEXCOORD : TEXCOORD1;

    float3 NORMAL : TEXCOORD2;

    float4 TANGENT : TEXCOORD3;

    float4 COLOR : TEXCOORD4;

    float2 TEXCOORD_1 : TEXCOORD5;

    uint gl_VertexIndex : SV_VertexID;

    uint gl_InstanceIndex : SV_InstanceID;

};



struct SPIRV_Cross_Output

{

    float4 TEXCOORD_2 : TEXCOORD1;

    float4 TEXCOORD_1_1 : TEXCOORD2;

    float4 TEXCOORD_2_1 : TEXCOORD3;

    float4 TEXCOORD_3 : TEXCOORD4;

    float4 TEXCOORD_4 : TEXCOORD5;

    float TEXCOORD_5 : TEXCOORD6;

    float4 gl_Position : SV_Position;

    float gl_ClipDistance0 : SV_ClipDistance0;

};



void vert_main()

{

    float _111 = float(int(asuint(_25_m0[0u].w))) * 7.62939453125e-06f;

    float _113 = float(int(asuint(_25_m0[1u].w))) * 7.62939453125e-06f;

    float _114 = float(int(asuint(_25_m0[2u].w))) * 7.62939453125e-06f;

    float _119 = (NORMAL.x * 2.0f) + (-1.0f);

    float _121 = (NORMAL.y * 2.0f) + (-1.0f);

    float _122 = (NORMAL.z * 2.0f) + (-1.0f);

    float _126 = (TANGENT.x * 2.0f) + (-1.0f);

    float _127 = (TANGENT.y * 2.0f) + (-1.0f);

    float _128 = (TANGENT.z * 2.0f) + (-1.0f);

    float _130 = (TANGENT.w * 2.0f) + (-1.0f);

    float _140 = ((_121 * _128) - (_122 * _127)) * _130;

    float _141 = ((_122 * _126) - (_119 * _128)) * _130;

    float _142 = ((_119 * _127) - (_121 * _126)) * _130;

    float _146 = mad(_128, _25_m0[0u].z, mad(_127, _25_m0[0u].y, _25_m0[0u].x * _126));

    float _149 = mad(_128, _25_m0[1u].z, mad(_127, _25_m0[1u].y, _25_m0[1u].x * _126));

    float _152 = mad(_128, _25_m0[2u].z, mad(_127, _25_m0[2u].y, _25_m0[2u].x * _126));

    float _155 = mad(_142, _25_m0[0u].z, mad(_141, _25_m0[0u].y, _140 * _25_m0[0u].x));

    float _158 = mad(_142, _25_m0[1u].z, mad(_141, _25_m0[1u].y, _140 * _25_m0[1u].x));

    float _161 = mad(_142, _25_m0[2u].z, mad(_141, _25_m0[2u].y, _25_m0[2u].x * _140));

    float _165 = rsqrt(dot(float3(_155, _158, _161), float3(_155, _158, _161)));

    float _172 = rsqrt(dot(float3(_146, _149, _152), float3(_146, _149, _152)));

    uint _178 = ((uint(gl_InstanceIndex) - uint(gl_BaseInstanceARB)) << 8u) + (uint(gl_VertexIndex) - uint(gl_BaseVertexARB));

    uint _179 = _178 / 12u;

    uint _184 = uint(_20_m0[0u].x);

    uint _187 = _184 - (_179 % _184);

    uint _188 = _179 / _184;

    float4 _193 = _8.Load(int3(uint2(_187, _188), 0u));

    float4 _200 = _8.Load(int3(uint2(_187 + _184, _188), 0u));

    float4 _208 = _8.Load(int3(uint2((_184 << 1u) + _187, _188), 0u));

    float _213 = ((_188 >= _184) || (_187 >= (_184 * 3u))) ? 0.0f : 1.0f;

    float _216 = _208.x * _213;

    float _217 = _208.y * _213;

    float _218 = _208.z * _213;

    float _223 = (_200.x * 2.0f) + (-1.0f);

    float _224 = (_200.y * 2.0f) + (-1.0f);

    float _225 = (_200.z * 2.0f) + (-1.0f);

    float _226 = (_200.w * 2.0f) + (-1.0f);

    float _237 = _20_m0[2u].x - _20_m0[1u].x;

    float _238 = _20_m0[2u].y - _20_m0[1u].y;

    float _239 = _20_m0[2u].z - _20_m0[1u].z;

    float _243 = (_237 * _193.x) + _20_m0[1u].x;

    float _244 = (_238 * _193.y) + _20_m0[1u].y;

    float _245 = (_239 * _193.z) + _20_m0[1u].z;

    float _264 = (mad(_245, _25_m0[0u].z, mad(_244, _25_m0[0u].y, _243 * _25_m0[0u].x)) + _111) - _15_m0[36u].x;

    float _265 = (mad(_245, _25_m0[1u].z, mad(_244, _25_m0[1u].y, _243 * _25_m0[1u].x)) + _113) - _15_m0[36u].y;

    float _266 = (mad(_245, _25_m0[2u].z, mad(_244, _25_m0[2u].y, _243 * _25_m0[2u].x)) + _114) - _15_m0[36u].z;

    float _270 = rsqrt(dot(float3(_264, _265, _266), float3(_264, _265, _266)));

    float _271 = _264 * _270;

    float _272 = _265 * _270;

    float _273 = _266 * _270;

    uint _275 = (_178 % 12u) >> 2u;

    uint _276 = _178 & 3u;

    bool _277 = _275 == 1u;

    bool _279 = _275 == 2u;

    float _280 = float(_279);

    float _281 = _279 ? 0.0f : float(_277);

    bool _284 = (_275 + 4294967295u) < 2u;

    float _285 = _284 ? 0.0f : 1.0f;

    float _295 = ((_285 * _224) - (_281 * _225)) * 2.0f;

    float _296 = ((_280 * _225) - (_285 * _223)) * 2.0f;

    float _297 = ((_281 * _223) - (_280 * _224)) * 2.0f;

    float _313 = ((_295 * _226) + _280) + ((_297 * _224) - (_296 * _225));

    float _314 = ((_296 * _226) + _281) + ((_295 * _225) - (_297 * _223));

    float _315 = ((_297 * _226) + _285) + ((_296 * _223) - (_295 * _224));

    float _318 = mad(_315, _25_m0[0u].z, mad(_314, _25_m0[0u].y, _313 * _25_m0[0u].x));

    float _321 = mad(_315, _25_m0[1u].z, mad(_314, _25_m0[1u].y, _313 * _25_m0[1u].x));

    float _324 = mad(_315, _25_m0[2u].z, mad(_314, _25_m0[2u].y, _313 * _25_m0[2u].x));

    float _328 = rsqrt(dot(float3(_318, _321, _324), float3(_318, _321, _324)));

    bool _335 = dot(float3(_271, _272, _273), float3(_328 * _318, _328 * _321, _328 * _324)) < 0.0f;

    float _336 = _335 ? (-1.0f) : 1.0f;

    float _84[3];

    float _85[3];

    _84[0u] = _216;

    _85[0u] = _217;

    _84[1u] = _216;

    _85[1u] = _218;

    _84[2u] = _217;

    _85[2u] = _218;

    bool _350 = _276 == 1u;

    bool _351 = _276 == 2u;

    bool _352 = _276 == 3u;

    bool _354 = (_275 & 2u) != 0u;

    precise float _355 = (-0.0f) - _336;

    float _361 = _352 ? _336 : (_351 ? (-1.0f) : (_350 ? _355 : 1.0f));

    float _362 = _352 ? _336 : (_351 ? 1.0f : (_350 ? _355 : (-1.0f)));

    float _375 = (_354 ? _355 : (_277 ? (_352 ? _355 : (_351 ? (-1.0f) : (_350 ? _336 : 1.0f))) : _361)) * _216;

    float _376 = (_354 ? _361 : (_277 ? _355 : _362)) * _217;

    float _377 = (_354 ? _362 : (_277 ? (_352 ? _355 : (_351 ? 1.0f : (_350 ? _336 : (-1.0f)))) : _355)) * _218;

    float _387 = ((_377 * _224) - (_376 * _225)) * 2.0f;

    float _388 = ((_375 * _225) - (_377 * _223)) * 2.0f;

    float _389 = ((_376 * _223) - (_375 * _224)) * 2.0f;

    float _414 = (((((_387 * _226) + _375) - (_388 * _225)) + (_389 * _224)) * _20_m0[3u].x) + _243;

    float _415 = (((((_388 * _226) + _376) - (_389 * _223)) + (_387 * _225)) * _20_m0[3u].x) + _244;

    float _416 = (((((_389 * _226) + _377) - (_387 * _224)) + (_388 * _223)) * _20_m0[3u].x) + _245;

    float _420 = mad(_416, _25_m0[0u].z, mad(_415, _25_m0[0u].y, _414 * _25_m0[0u].x)) + _111;

    float _424 = mad(_416, _25_m0[1u].z, mad(_415, _25_m0[1u].y, _414 * _25_m0[1u].x)) + _113;

    float _428 = mad(_416, _25_m0[2u].z, mad(_415, _25_m0[2u].y, _414 * _25_m0[2u].x)) + _114;

    float _483 = rsqrt(dot(float3(_313, _314, _315), float3(_313, _314, _315)));

    float _484 = _313 * _483;

    float _485 = _314 * _483;

    float _486 = _315 * _483;

    float _489 = mad(_486, _25_m0[0u].z, mad(_485, _25_m0[0u].y, _484 * _25_m0[0u].x));

    float _492 = mad(_486, _25_m0[1u].z, mad(_485, _25_m0[1u].y, _484 * _25_m0[1u].x));

    float _495 = mad(_486, _25_m0[2u].z, mad(_485, _25_m0[2u].y, _484 * _25_m0[2u].x));

    float _499 = rsqrt(dot(float3(_489, _492, _495), float3(_489, _492, _495)));

    float _500 = _499 * _489;

    float _501 = _499 * _492;

    float _502 = _499 * _495;

    bool _506 = dot(float3(_271, _272, _273), float3(_500, _501, _502)) < 0.0f;

    float _516 = rsqrt(dot(float3(_280, _281, _285), float3(_280, _281, _285)));

    float _525 = (dot(0.57735025882720947265625f.xxx, float3(_280 * _516, _281 * _516, _285 * _516)) < 0.0f) ? (-1.0f) : 1.0f;

    precise float _526 = (-0.0f) - _525;

    float _531 = _352 ? _525 : (_351 ? (-1.0f) : (_350 ? _526 : 1.0f));

    float _532 = _352 ? _525 : (_351 ? 1.0f : (_350 ? _526 : (-1.0f)));

    float _543 = _354 ? _531 : (_277 ? _526 : _532);

    float _555 = clamp(1.0f - ((_416 - _20_m0[1u].z) / _239), 0.0f, 1.0f);

    float _558 = clamp(1.0f - (_555 * _555), 0.0f, 1.0f);

    gl_Position.x = mad(_428, _15_m0[0u].z, mad(_424, _15_m0[0u].y, _15_m0[0u].x * _420)) + _15_m0[0u].w;

    gl_Position.y = mad(_428, _15_m0[1u].z, mad(_424, _15_m0[1u].y, _15_m0[1u].x * _420)) + _15_m0[1u].w;

    gl_Position.z = mad(_428, _15_m0[2u].z, mad(_424, _15_m0[2u].y, _15_m0[2u].x * _420)) + _15_m0[2u].w;

    gl_Position.w = mad(_428, _15_m0[3u].z, mad(_424, _15_m0[3u].y, _15_m0[3u].x * _420)) + _15_m0[3u].w;

    TEXCOORD_2.x = ((_279 ? _543 : (_354 ? _526 : (_277 ? (_352 ? _526 : (_351 ? (-1.0f) : (_350 ? _525 : 1.0f))) : _531))) + 1.0f) * 0.5f;

    TEXCOORD_2.y = ((_284 ? (_354 ? _532 : (_277 ? (_352 ? _526 : (_351 ? 1.0f : (_350 ? _525 : (-1.0f)))) : _526)) : _543) + 1.0f) * 0.5f;

    TEXCOORD_2.z = _506 ? _500 : ((-0.0f) - _500);

    TEXCOORD_2.w = _506 ? _501 : ((-0.0f) - _501);

    TEXCOORD_1_1.x = _506 ? _502 : ((-0.0f) - _502);

    TEXCOORD_1_1.y = _165 * _155;

    TEXCOORD_1_1.z = _165 * _158;

    TEXCOORD_1_1.w = _165 * _161;

    TEXCOORD_2_1.x = _172 * _146;

    TEXCOORD_2_1.y = _172 * _149;

    TEXCOORD_2_1.z = _172 * _152;

    TEXCOORD_2_1.w = _420;

    TEXCOORD_3.x = _424;

    TEXCOORD_3.y = _428;

    TEXCOORD_3.z = (clamp(_20_m0[4u].x, 0.0f, 1.0f) * (1.0f - _558)) + _558;

    TEXCOORD_3.w = (_20_m0[5u].z + 0.5f) + (_20_m0[5u].x * (((_414 - _20_m0[1u].x) / _237) + (-0.5f)));

    TEXCOORD_4.x = (_20_m0[5u].w + 0.5f) + (_20_m0[5u].y * (((_415 - _20_m0[1u].y) / _238) + (-0.5f)));

    TEXCOORD_4.y = COLOR.w;

    TEXCOORD_4.z = mad(_428, _15_m0[22u].z, mad(_424, _15_m0[22u].y, _15_m0[22u].x * _420)) + _15_m0[22u].w;

    TEXCOORD_4.w = _335 ? _85[_275] : _84[_275];

    TEXCOORD_5 = _335 ? _84[_275] : _85[_275];

    gl_ClipDistance[0u] = dot(float4(_15_m0[50u]), float4(_420, _424, _428, 1.0f));
}
SPIRV_Cross_Output main(SPIRV_Cross_Input stage_input)
{

    gl_VertexIndex = int(stage_input.gl_VertexIndex);

    gl_InstanceIndex = int(stage_input.gl_InstanceIndex);

    gl_BaseVertexARB = SPIRV_Cross_BaseVertex;

    gl_BaseInstanceARB = SPIRV_Cross_BaseInstance;

    POSITION = stage_input.POSITION;

    TEXCOORD = stage_input.TEXCOORD;

    NORMAL = stage_input.NORMAL;

    TANGENT = stage_input.TANGENT;

    COLOR = stage_input.COLOR;

    TEXCOORD_1 = stage_input.TEXCOORD_1;

    vert_main();

    SPIRV_Cross_Output stage_output;

    stage_output.gl_Position = gl_Position;

    stage_output.gl_ClipDistance0.x = gl_ClipDistance[0];

    stage_output.TEXCOORD_2 = TEXCOORD_2;

    stage_output.TEXCOORD_1_1 = TEXCOORD_1_1;

    stage_output.TEXCOORD_2_1 = TEXCOORD_2_1;

    stage_output.TEXCOORD_3 = TEXCOORD_3;

    stage_output.TEXCOORD_4 = TEXCOORD_4;

    stage_output.TEXCOORD_5 = TEXCOORD_5;

    return stage_output;
}