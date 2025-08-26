---
title: CORE-V CVA6 Open-Source Manycore RISC-V Architecture
subtitle: We have been striving to build a design that is portable across simulators and technology processes and we are excited to bring support for coherent, manycore OpenHW CORE-V CVA6 clusters on Intel FPGAs through an upcoming release.
headline: CORE-V CVA6 Open-Source Manycore RISC-V Architecture
date: 2022-11-30T09:00:00-04:00
hide_page_title: true
categories: ["blogs"]
summary: We have been striving to build a design that is portable across simulators and technology processes and we are excited to bring support for coherent, manycore OpenHW CORE-V CVA6 clusters on Intel FPGAs through an upcoming release. This bolsters our position of OpenPiton and CVA6 being an ideal platform for RISC-V software development as the broader ecosystem continues to mature.
author: Jonathan Balkind - Assistant Professor of Computer Science at UCSB
---

{{< grid/div class="row padding-bottom-40 padding-top-40" isMarkdown="false" >}}
    {{< grid/div class="col-sm-10 col-sm-offset-2" isMarkdown="false">}}
        <a href="https://github.com/openhwgroup/core-v-cores" title="The GitHub repository for CORE-V">
            <img class="img img-responsive" src="./images/core-v.png" alt="" />
        </a>
    {{</ grid/div >}}
    {{< grid/div class="col-sm-10 col-sm-offset-2" isMarkdown="false">}}
        <a href="https://pathfinder.intel.com" title="Intel Pathfinder for RISC-V's website">
            <img class="img img-responsive" src="./images/intel-pathfinder-for-risc-v.png" alt="" width="300" />
        </a>
    {{</ grid/div >}}
    {{< grid/div class="col-sm-18 col-sm-offset-4 padding-top-40" isMarkdown="false">}}
        <a href="https://engineering.ucsb.edu/" title="The University of California Santa Barbara's website">
            <img class="img img-responsive" src="./images/ucsb-college-of-engineering.png" alt="" />
        </a>
    {{</ grid/div >}}
{{</ grid/div >}}

*Author: Jonathan Balkind - Assistant Professor of Computer Science at UCSB*

With nine years of development under our belts, a key philosophy of the OpenPiton platform is to provide scalable, high-performance manycore processors in an open, technology-agnostic, and upstream-first way. We have been striving to build a design that is portable across simulators and technology processes and we are excited to bring support for coherent, manycore [OpenHW CORE-V CVA6](https://github.com/openhwgroup/cva6) clusters on Intel FPGAs through an upcoming release. This bolsters our position of OpenPiton and CVA6 being an ideal platform for RISC-V software development as the broader ecosystem continues to mature.

OpenPiton has a particular focus on enabling advanced research, providing a common design which can be integrated with for research and early-stage development in a variety of new technology areas. As a result, we are very excited about Intel's recent work with CVA6 and OpenPiton, as demonstrated in their VLSI Technology Symposium paper, "[An 8-core RISC-V Processor with Compute near Last Level Cache in Intel 4 CMOS](https://ieeexplore.ieee.org/document/9830518)". Taping out such a cluster in an advanced technology node such as Intel 4 while demonstrating functioning multicore Linux shows the potential for others to build advanced systems with CVA6 clusters. The functioning 8-core design is representative of CVA6 clusters that we would like to standardize in the OpenHW ecosystem for broad community use.

{{< figure src="./images/cluster.jpg" alt="C" class="margin-40" caption="CORE-V CVA6 8-core Open-Source RISC-V Cluster" >}}

Thanks to recent contributions to CVA6, our upcoming releases will bring CVA6 support to parity with the upstream core managed by OpenHW Group. With U-Boot recently adopting OpenPiton and CVA6 as a supported platform, we will offer a standard Linux boot environment with all upstream-supported technology. With support for [Intel® Pathfinder for RISC-V*](https://pathfinder.intel.com/), software developers will be able to test out their software on a standard CVA6 core cluster on FPGAs with confidence for the accompanying hardware design being realized in silicon.

Learn more about our work by visiting my [Jonathan Balkind profile at UC Santa Barbara](https://www.cs.ucsb.edu/people/faculty/jonathan-balkind).

{{< grid/div isMarkdown="false" >}}
<small class="small">
    * Intel, the Intel logo, and other Intel marks are trademarks of Intel Corporation or its subsidiaries. Other names and brands may be claimed as the property of others.
</small>

{{< /grid/div >}}
