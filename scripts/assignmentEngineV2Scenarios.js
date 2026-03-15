module.exports = [
  {
    name: "rn_imbalanced_discharge_stack",
    role: "nurse",
    owners: [
      { id: 1, name: "Incoming RN 1", patients: [1, 2, 4, 5] },
      { id: 2, name: "Incoming RN 2", patients: [3, 6, 7, 8, 9] },
      { id: 3, name: "Incoming RN 3", patients: [10, 11, 12] }
    ],
    prevOwnerByPid: {
      1: "Incoming RN 1",
      2: "Incoming RN 1",
      3: "Incoming RN 2",
      4: "Incoming RN 1",
      5: "Incoming RN 1",
      6: "Incoming RN 2",
      7: "Incoming RN 2",
      8: "Incoming RN 2",
      9: "Incoming RN 2",
      10: "Incoming RN 3",
      11: "Incoming RN 3",
      12: "Incoming RN 3"
    },
    patients: [
      { id: 1, room: "201A", expectedDischarge: true },
      { id: 2, room: "201B", expectedDischarge: true, nih: true, drip: true, tele: true },
      { id: 3, room: "202B", sitter: true, lateDc: true, tele: true },
      { id: 4, room: "217A", expectedDischarge: true, tele: true },
      { id: 5, room: "219B", expectedDischarge: true, isolation: true },
      { id: 6, room: "204A" },
      { id: 7, room: "209", tele: true },
      { id: 8, room: "215A" },
      { id: 9, room: "217B" },
      { id: 10, room: "204B", drip: true, bg: true, tele: true },
      { id: 11, room: "218A" },
      { id: 12, room: "220B", tele: true }
    ]
  },
  {
    name: "rn_pinned_patient_stays_put",
    role: "nurse",
    owners: [
      { id: 1, name: "Incoming RN 1", patients: [21, 22, 23, 24, 25] },
      { id: 2, name: "Incoming RN 2", patients: [26, 27, 28] },
      { id: 3, name: "Incoming RN 3", patients: [29, 30, 31, 32] }
    ],
    prevOwnerByPid: {
      21: "Incoming RN 1",
      22: "Incoming RN 1",
      23: "Incoming RN 1",
      24: "Incoming RN 1",
      25: "Incoming RN 1",
      26: "Incoming RN 2",
      27: "Incoming RN 2",
      28: "Incoming RN 2",
      29: "Incoming RN 3",
      30: "Incoming RN 3",
      31: "Incoming RN 3",
      32: "Incoming RN 3"
    },
    patients: [
      { id: 21, room: "210A", expectedDischarge: true, lockRnEnabled: true, lockRnTo: 1 },
      { id: 22, room: "210B", expectedDischarge: true },
      { id: 23, room: "211A" },
      { id: 24, room: "211B" },
      { id: 25, room: "212A" },
      { id: 26, room: "212B" },
      { id: 27, room: "213A" },
      { id: 28, room: "213B" },
      { id: 29, room: "214A" },
      { id: 30, room: "214B" },
      { id: 31, room: "215A" },
      { id: 32, room: "215B" }
    ]
  }
];
